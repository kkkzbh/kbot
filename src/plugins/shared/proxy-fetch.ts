import { ProxyAgent, type Dispatcher } from 'undici';

const proxyAgents = new Map<string, ProxyAgent>();

export type ProxyFetchInit = RequestInit & {
  dispatcher?: Dispatcher;
};

export type ProxyFetchRequest = {
  init: ProxyFetchInit;
  proxyUrl: string | null;
};

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function defaultPortForProtocol(protocol: string): string {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return '';
}

function parseNoProxyEntry(entry: string): { host: string; port: string | null } {
  const value = entry.trim().toLowerCase();
  if (!value) return { host: '', port: null };
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end >= 0) {
      const host = value.slice(1, end);
      const rest = value.slice(end + 1);
      return { host, port: rest.startsWith(':') ? rest.slice(1) : null };
    }
  }
  const lastColon = value.lastIndexOf(':');
  if (lastColon > 0 && value.indexOf(':') === lastColon) {
    const port = value.slice(lastColon + 1);
    if (/^\d+$/.test(port)) return { host: value.slice(0, lastColon), port };
  }
  return { host: value, port: null };
}

function matchesNoProxyHost(host: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  if (pattern.startsWith('.')) {
    const suffix = pattern.slice(1);
    return host === suffix || host.endsWith(pattern);
  }
  return host === pattern;
}

function shouldBypassProxy(url: URL, env: NodeJS.ProcessEnv): boolean {
  const raw = trimOptionalText(env.NO_PROXY) ?? trimOptionalText(env.no_proxy);
  if (!raw) return false;
  const host = url.hostname.toLowerCase();
  const port = url.port || defaultPortForProtocol(url.protocol);
  return raw.split(',').some((entry) => {
    const parsed = parseNoProxyEntry(entry);
    if (!parsed.host) return false;
    if (parsed.port && parsed.port !== port) return false;
    return matchesNoProxyHost(host, parsed.host);
  });
}

function resolveProxyUrl(target: string, env: NodeJS.ProcessEnv): string | null {
  const url = new URL(target);
  if (shouldBypassProxy(url, env)) return null;
  const proxy =
    url.protocol === 'http:'
      ? trimOptionalText(env.HTTP_PROXY) ?? trimOptionalText(env.http_proxy) ?? trimOptionalText(env.ALL_PROXY) ?? trimOptionalText(env.all_proxy)
      : trimOptionalText(env.HTTPS_PROXY) ?? trimOptionalText(env.https_proxy) ?? trimOptionalText(env.ALL_PROXY) ?? trimOptionalText(env.all_proxy);
  if (!proxy) return null;
  const parsed = new URL(proxy);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`出站代理协议不支持：${parsed.protocol}，请使用 http 或 https 代理。`);
  }
  return parsed.toString();
}

function redactProxyUrl(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  if (url.username || url.password) {
    url.username = '***';
    url.password = '';
  }
  return url.toString();
}

function getProxyAgent(proxyUrl: string): ProxyAgent {
  const current = proxyAgents.get(proxyUrl);
  if (current) return current;
  const agent = new ProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, agent);
  return agent;
}

export function createProxyFetchRequest(
  target: string,
  init: RequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
): ProxyFetchRequest {
  const proxyUrl = resolveProxyUrl(target, env);
  if (!proxyUrl) return { init, proxyUrl: null };
  return {
    init: {
      ...init,
      dispatcher: getProxyAgent(proxyUrl),
    },
    proxyUrl,
  };
}

export function formatProxyFetchFailure(
  label: string,
  target: string,
  proxyUrl: string | null,
  error: unknown,
): string {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null;
  const causeCode = typeof cause === 'object' && cause && 'code' in cause
    ? String((cause as { code?: unknown }).code ?? '')
    : '';
  const causeMessage = cause instanceof Error ? cause.message : '';
  const message = error instanceof Error ? error.message : String(error);
  const detail = [causeCode, causeMessage || message].filter(Boolean).join(' ');
  const proxy = proxyUrl ? `，proxy=${redactProxyUrl(proxyUrl)}` : '';
  return `${label}失败：${detail || message}（url=${target}${proxy}）`;
}
