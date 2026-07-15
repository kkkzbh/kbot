import { Logger } from 'koishi';
import type { AdminLogEntry } from '../../admin/contracts/index.js';

const DEFAULT_CAPACITY = 1_000;
const SECRET_ENV_KEY_PATTERN = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL)/i;
const MIN_SECRET_LENGTH = 8;

function configuredSecretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_ENV_KEY_PATTERN.test(key) && (value?.length ?? 0) >= MIN_SECRET_LENGTH)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

export function redactAdminLogContent(content: string, secretValues = configuredSecretValues(process.env)): string {
  let redacted = content;
  for (const secret of secretValues) redacted = redacted.split(secret).join('[REDACTED]');
  return redacted
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|api_key|token|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?secret|password)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
}

export class AdminLogService {
  private readonly entries: AdminLogEntry[] = [];
  private readonly target: Logger.Target;
  private readonly secretValues: string[];
  private disposed = false;

  constructor(private readonly capacity = DEFAULT_CAPACITY, env: NodeJS.ProcessEnv = process.env) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Admin log capacity 必须是正整数。');
    this.secretValues = configuredSecretValues(env);
    this.target = {
      levels: { base: Logger.DEBUG },
      record: (record) => this.capture(record),
    };
    Logger.targets.push(this.target);
  }

  private capture(record: Logger.Record): void {
    this.entries.push({
      id: record.id,
      timestamp: record.timestamp,
      level: record.type,
      namespace: record.name,
      content: redactAdminLogContent(record.content, this.secretValues),
    });
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  read(after: number, limit: number): { entries: AdminLogEntry[]; nextCursor: number; truncated: boolean } {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Admin log cursor 无效。');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Admin log limit 无效。');

    const oldestId = this.entries[0]?.id ?? 0;
    const latestId = this.entries.at(-1)?.id ?? 0;
    const truncated = after > 0 && oldestId > after + 1;
    const entries = after === 0
      ? this.entries.slice(-limit)
      : this.entries.filter((entry) => entry.id > after).slice(0, limit);
    return {
      entries: entries.map((entry) => ({ ...entry })),
      nextCursor: entries.at(-1)?.id ?? Math.max(after, latestId),
      truncated,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const index = Logger.targets.indexOf(this.target);
    if (index >= 0) Logger.targets.splice(index, 1);
  }
}
