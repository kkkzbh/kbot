import type { ChaoxingCookie, SerializedChaoxingCookieJar } from './types.js';

type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

export class ChaoxingCookieJar {
  private readonly cookies = new Map<string, ChaoxingCookie>();

  static from(serialized: SerializedChaoxingCookieJar): ChaoxingCookieJar {
    const jar = new ChaoxingCookieJar();
    for (const cookie of serialized.cookies) jar.set(cookie);
    return jar;
  }

  serialize(now = Date.now()): SerializedChaoxingCookieJar {
    this.removeExpired(now);
    return { cookies: [...this.cookies.values()].map((cookie) => ({ ...cookie })) };
  }

  get(name: string, now = Date.now()): string | null {
    this.removeExpired(now);
    const matches = [...this.cookies.values()].filter((cookie) => cookie.name === name);
    matches.sort((left, right) => right.path.length - left.path.length);
    return matches[0]?.value ?? null;
  }

  cookieHeader(url: URL, now = Date.now()): string {
    this.removeExpired(now);
    return [...this.cookies.values()]
      .filter((cookie) => matchesCookie(cookie, url))
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  absorb(response: Response, requestUrl: URL, now = Date.now()): void {
    const values = readSetCookieHeaders(response.headers as HeadersWithSetCookie);
    for (const value of values) {
      const cookie = parseSetCookie(value, requestUrl, now);
      if (!cookie) continue;
      if (cookie.expiresAt != null && cookie.expiresAt <= now) {
        this.cookies.delete(cookieKey(cookie));
      } else {
        this.set(cookie);
      }
    }
  }

  private set(cookie: ChaoxingCookie): void {
    this.cookies.set(cookieKey(cookie), { ...cookie, domain: cookie.domain.toLowerCase() });
  }

  private removeExpired(now: number): void {
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt != null && cookie.expiresAt <= now) this.cookies.delete(key);
    }
  }
}

export function parseSetCookie(value: string, requestUrl: URL, now = Date.now()): ChaoxingCookie | null {
  const segments = value.split(';').map((segment) => segment.trim()).filter(Boolean);
  const first = segments.shift();
  if (!first) return null;
  const separator = first.indexOf('=');
  if (separator <= 0) return null;
  const name = first.slice(0, separator).trim();
  const cookieValue = first.slice(separator + 1);
  if (!name) return null;

  let domain = requestUrl.hostname.toLowerCase();
  let hostOnly = true;
  let path = defaultCookiePath(requestUrl.pathname);
  let secure = false;
  let httpOnly = false;
  let expiresAt: number | null = null;

  for (const segment of segments) {
    const attributeSeparator = segment.indexOf('=');
    const rawKey = attributeSeparator < 0 ? segment : segment.slice(0, attributeSeparator);
    const rawValue = attributeSeparator < 0 ? '' : segment.slice(attributeSeparator + 1);
    const key = rawKey.trim().toLowerCase();
    if (key === 'domain') {
      const normalized = rawValue.trim().replace(/^\./, '').toLowerCase();
      if (!domainMatches(requestUrl.hostname, normalized)) return null;
      domain = normalized;
      hostOnly = false;
    } else if (key === 'path') {
      path = rawValue.startsWith('/') ? rawValue : '/';
    } else if (key === 'secure') {
      secure = true;
    } else if (key === 'httponly') {
      httpOnly = true;
    } else if (key === 'max-age') {
      const seconds = Number(rawValue);
      if (Number.isFinite(seconds)) expiresAt = now + seconds * 1000;
    } else if (key === 'expires' && expiresAt == null) {
      const parsed = Date.parse(rawValue);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
  }

  return { name, value: cookieValue, domain, path, hostOnly, secure, httpOnly, expiresAt };
}

function readSetCookieHeaders(headers: HeadersWithSetCookie): string[] {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  return splitCombinedSetCookie(combined);
}

function splitCombinedSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/u).map((part) => part.trim()).filter(Boolean);
}

function matchesCookie(cookie: ChaoxingCookie, url: URL): boolean {
  if (cookie.secure && url.protocol !== 'https:') return false;
  if (cookie.hostOnly ? url.hostname.toLowerCase() !== cookie.domain : !domainMatches(url.hostname, cookie.domain)) return false;
  return pathMatches(url.pathname, cookie.path);
}

function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const normalizedDomain = domain.toLowerCase();
  return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith('/') || pathname === '/') return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function cookieKey(cookie: Pick<ChaoxingCookie, 'name' | 'domain' | 'path'>): string {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
}
