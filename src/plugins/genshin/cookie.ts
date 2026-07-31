import {
  GENSHIN_COOKIE_FIELD_NAMES,
  type GenshinCookieFields,
} from './types.js';
import { GenshinUserError } from './types.js';

export function hasGenshinAdvancedCookieCapability(fields: GenshinCookieFields): boolean {
  return Boolean(fields.stoken && (fields.mid || fields.stuid));
}

export function assertGenshinAdvancedCookieCapability(fields: GenshinCookieFields, message: string): void {
  if (!hasGenshinAdvancedCookieCapability(fields)) throw new GenshinUserError(message);
}

export function buildGenshinCookieHeader(fields: GenshinCookieFields): string {
  return GENSHIN_COOKIE_FIELD_NAMES
    .flatMap((name) => {
      const value = fields[name];
      return value ? [`${name}=${value}`] : [];
    })
    .join('; ');
}
