import {
  GENSHIN_COOKIE_FIELD_NAMES,
  type GenshinCookieFieldName,
  type GenshinCookieFields,
} from './types.js';
import { GenshinUserError } from './types.js';

const COOKIE_FIELD_SET = new Set<string>(GENSHIN_COOKIE_FIELD_NAMES);
const ACCOUNT_ID_FIELDS: readonly GenshinCookieFieldName[] = [
  'account_id',
  'account_id_v2',
  'login_uid',
  'ltuid',
  'ltuid_v2',
  'stuid',
];

export function parseGenshinCookieInput(input: string): GenshinCookieFields {
  const raw = input.trim();
  if (!raw) {
    throw new GenshinUserError('请粘贴 Cookie-Editor 复制的完整 Cookie。');
  }

  const pairs = raw.startsWith('[') ? parseJsonCookieArray(raw) : parseCookieText(raw);
  const fields: GenshinCookieFields = {};
  for (const [name, value] of pairs) {
    const key = name.trim();
    if (!COOKIE_FIELD_SET.has(key)) continue;
    const normalized = value.trim();
    if (normalized) {
      fields[key as GenshinCookieFieldName] = normalized;
    }
  }
  validateGenshinCookieFields(fields);
  return fields;
}

export function validateGenshinCookieFields(fields: GenshinCookieFields): void {
  if (!fields.stoken) {
    throw new GenshinUserError('Cookie 缺少 stoken，请在米游社登录后重新复制完整 Cookie。');
  }
  if (!fields.mid && !fields.stuid) {
    throw new GenshinUserError('Cookie 缺少 mid 或 stuid，请在米游社登录后重新复制完整 Cookie。');
  }
  if (!ACCOUNT_ID_FIELDS.some((name) => Boolean(fields[name]))) {
    throw new GenshinUserError('Cookie 缺少账号 id，请在米游社登录后重新复制完整 Cookie。');
  }
}

export function buildGenshinCookieHeader(fields: GenshinCookieFields): string {
  return GENSHIN_COOKIE_FIELD_NAMES
    .flatMap((name) => {
      const value = fields[name];
      return value ? [`${name}=${value}`] : [];
    })
    .join('; ');
}

function parseJsonCookieArray(raw: string): Array<[string, string]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GenshinUserError('Cookie-Editor JSON 格式解析失败，请重新复制当前站点全部 Cookie。');
  }
  if (!Array.isArray(parsed)) {
    throw new GenshinUserError('Cookie-Editor JSON 必须是 Cookie 数组。');
  }
  return parsed.flatMap((item): Array<[string, string]> => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    const value = typeof record.value === 'string' ? record.value : '';
    return name ? [[name, value]] : [];
  });
}

function parseCookieText(raw: string): Array<[string, string]> {
  const withoutHeaderName = raw.replace(/^cookie\s*:\s*/i, '');
  if (looksLikeNetscapeCookieText(withoutHeaderName)) {
    return parseNetscapeCookieText(withoutHeaderName);
  }
  return withoutHeaderName
    .split(';')
    .flatMap((part): Array<[string, string]> => {
      const index = part.indexOf('=');
      if (index <= 0) return [];
      return [[part.slice(0, index), part.slice(index + 1)]];
    });
}

function looksLikeNetscapeCookieText(raw: string): boolean {
  return raw
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return trimmed.split('\t').length >= 7;
    });
}

function parseNetscapeCookieText(raw: string): Array<[string, string]> {
  return raw
    .split(/\r?\n/)
    .flatMap((line): Array<[string, string]> => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return [];
      const parts = trimmed.split('\t');
      if (parts.length < 7) return [];
      return [[parts[5] ?? '', parts.slice(6).join('\t')]];
    });
}
