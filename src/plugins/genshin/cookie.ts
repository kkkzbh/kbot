import {
  GENSHIN_COOKIE_FIELD_NAMES,
  type GenshinCookieFields,
} from './types.js';
import { GenshinUserError } from './types.js';

export function hasGenshinRedeemCookieCapability(fields: GenshinCookieFields): boolean {
  return Boolean(fields.stoken && (fields.mid || fields.stuid));
}

export function assertGenshinRedeemCookieCapability(fields: GenshinCookieFields): void {
  if (!hasGenshinRedeemCookieCapability(fields)) {
    throw new GenshinUserError('当前绑定 Cookie 不包含 stoken + mid/stuid，不能领取兑换码。请重新绑定包含这组字段的更高权限 Cookie。');
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
