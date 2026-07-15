import { Context, Logger, Schema } from 'koishi';
import type { CampusAuthServiceLike } from '../../types/campus-auth.js';
import '../../types/campus-auth.js';
import { loadOrCreateKek, resolveKekPath } from '../shared/credential-crypto.js';
import { renderCampusBindPage } from './bind-page.js';
import { renderCampusLocationActionPage } from './action-page.js';
import { CampusAuthService } from './service.js';
import { ensureCampusAuthTables, CampusAuthStore } from './store.js';
import type { CampusAuthDatabase, CampusAuthMethod } from './types.js';
import { CampusAuthUserError } from './types.js';

export * from './types.js';
export { CampusAuthService } from './service.js';

export const name = 'campus-auth-core';
export const inject = ['server', 'database'] as const;

const logger = new Logger(name);
const DEFAULT_BIND_PAGE_PATH = '/campus/bind';
const DEFAULT_BIND_TOKEN_TTL_MS = 600_000;
const DEFAULT_ACTION_PAGE_PATH = '/campus/action';
const DEFAULT_ACTION_TOKEN_TTL_MS = 300_000;
const DEFAULT_MAX_BINDING_ATTEMPTS = 5;

export interface Config {
  publicBaseUrl?: string;
  bindPagePath?: string;
  bindTokenTtlMs?: number;
  actionPagePath?: string;
  actionTokenTtlMs?: number;
  credentialKekPath?: string;
  maxBindingAttempts?: number;
}

export const Config: Schema<Config> = Schema.object({
  publicBaseUrl: Schema.string().description('校园账号绑定页的外部 HTTPS 基础地址。'),
  bindPagePath: Schema.string().default(DEFAULT_BIND_PAGE_PATH).description('统一校园账号绑定页路径。'),
  bindTokenTtlMs: Schema.natural().role('time').default(DEFAULT_BIND_TOKEN_TTL_MS).description('一次性绑定链接有效期。'),
  actionPagePath: Schema.string().default(DEFAULT_ACTION_PAGE_PATH).description('统一校园定位操作页路径。'),
  actionTokenTtlMs: Schema.natural().role('time').default(DEFAULT_ACTION_TOKEN_TTL_MS).description('一次性定位操作链接有效期。'),
  credentialKekPath: Schema.string().description('校园账号凭据 KEK 文件路径，权限必须为 0600。'),
  maxBindingAttempts: Schema.natural().default(DEFAULT_MAX_BINDING_ATTEMPTS).description('单个绑定链接最多允许的验证次数。'),
});

interface CampusAuthContext {
  database: CampusAuthDatabase;
  server: {
    get(path: string, handler: (koaCtx: any) => unknown): void;
    post(path: string, handler: (koaCtx: any) => unknown): void;
  };
}

export function apply(ctx: Context, config: Config): void {
  const serviceCtx = ctx as unknown as CampusAuthContext;
  const bindPagePath = requireAbsolutePath(config.bindPagePath ?? DEFAULT_BIND_PAGE_PATH, 'campus-auth-core.bindPagePath');
  const publicBaseUrl = normalizeBaseUrl(config.publicBaseUrl ?? `http://127.0.0.1:${process.env.KOISHI_PORT || '5140'}`);
  const bindTokenTtlMs = positiveInteger(config.bindTokenTtlMs ?? DEFAULT_BIND_TOKEN_TTL_MS, 'campus-auth-core.bindTokenTtlMs');
  const actionPagePath = requireAbsolutePath(config.actionPagePath ?? DEFAULT_ACTION_PAGE_PATH, 'campus-auth-core.actionPagePath');
  const actionTokenTtlMs = positiveInteger(config.actionTokenTtlMs ?? DEFAULT_ACTION_TOKEN_TTL_MS, 'campus-auth-core.actionTokenTtlMs');
  if (actionPagePath === bindPagePath) throw new Error('campus-auth-core.actionPagePath 不能与 bindPagePath 相同。');
  const maxBindingAttempts = positiveInteger(config.maxBindingAttempts ?? DEFAULT_MAX_BINDING_ATTEMPTS, 'campus-auth-core.maxBindingAttempts');
  const baseDir = String((ctx as { baseDir?: string }).baseDir ?? process.cwd());
  const kekPath = resolveKekPath(baseDir, config.credentialKekPath ?? './.runtime/campus-auth/credential-kek.key');

  ensureCampusAuthTables(ctx);
  const service = new CampusAuthService(
    new CampusAuthStore(serviceCtx.database),
    loadOrCreateKek(kekPath),
    { publicBaseUrl, bindPagePath, bindTokenTtlMs, actionPagePath, actionTokenTtlMs, maxBindingAttempts },
  );
  provideService(ctx, service);
  registerRoutes(serviceCtx, service, bindPagePath, actionPagePath);
  ctx.on?.('ready', () => service.cleanupExpiredChallenges());
  logger.info('campus auth bind page registered at %s.', bindPagePath);
  logger.info('campus location action page registered at %s.', actionPagePath);
}

function provideService(ctx: Context, service: CampusAuthServiceLike): void {
  const provider = ctx as Context & {
    provide?: (name: string) => void;
    set?: (name: string, value: unknown) => void;
  };
  if (typeof provider.provide === 'function' && typeof provider.set === 'function') {
    provider.provide('campusAuth');
    provider.set('campusAuth', service);
  } else {
    provider.campusAuth = service;
  }
}

function registerRoutes(ctx: CampusAuthContext, service: CampusAuthService, bindPagePath: string, actionPagePath: string): void {
  ctx.server.get(bindPagePath, async (koaCtx: any) => {
    const token = queryToken(koaCtx);
    try {
      const state = await service.resolveBindPage(token);
      const methods = state.state === 'form' ? await state.provider.getBindingMethods() : [];
      writeHtml(koaCtx, 200, renderCampusBindPage({
        providerId: state.provider.id,
        providerLabel: state.provider.label,
        qqUserId: state.challenge.qqUserId,
        token,
        submitPath: `${bindPagePath}/submit`,
        methods,
        state: state.state,
        confirmCommand: state.confirmCode ? `${state.provider.confirmCommandPrefix} ${state.confirmCode}` : undefined,
        message: state.challenge.errorMessage ?? undefined,
      }));
    } catch (error) {
      writeHtml(koaCtx, 400, renderCampusBindPage({
        providerLabel: '校园账号',
        qqUserId: '',
        state: 'invalid',
        message: userMessage(error),
      }));
    }
  });

  ctx.server.post(`${bindPagePath}/submit`, async (koaCtx: any) => {
    const body = await readRequestBody(koaCtx);
    const token = String(body.token ?? '').trim();
    const method = String(body.method ?? '') as CampusAuthMethod;
    const fields = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value ?? '')]));
    try {
      await service.submitBinding(token, method, fields);
      writeRedirect(koaCtx, `${bindPagePath}?token=${encodeURIComponent(token)}`);
    } catch (error) {
      try {
        const state = await service.resolveBindPage(token);
        writeHtml(koaCtx, 400, renderCampusBindPage({
          providerId: state.provider.id,
          providerLabel: state.provider.label,
          qqUserId: state.challenge.qqUserId,
          token,
          submitPath: `${bindPagePath}/submit`,
          methods: await state.provider.getBindingMethods(),
          selectedMethod: method,
          submittedFields: fields,
          state: state.state === 'verified' ? 'verified' : 'form',
          confirmCommand: state.confirmCode ? `${state.provider.confirmCommandPrefix} ${state.confirmCode}` : undefined,
          message: userMessage(error),
        }));
      } catch {
        writeHtml(koaCtx, 400, renderCampusBindPage({
          providerLabel: '校园账号',
          qqUserId: '',
          state: 'invalid',
          message: userMessage(error),
        }));
      }
    }
  });

  ctx.server.get(actionPagePath, async (koaCtx: any) => {
    const token = queryToken(koaCtx);
    try {
      const state = await service.resolveLocationActionPage(token);
      writeHtml(koaCtx, 200, renderCampusLocationActionPage({
        providerLabel: state.provider.label,
        token,
        preparePath: `${actionPagePath}/prepare`,
        commitPath: `${actionPagePath}/commit`,
        state: state.state,
        prepared: state.prepared,
        message: state.state === 'completed' ? state.challenge.resultMessage ?? undefined : state.challenge.errorMessage ?? undefined,
      }));
    } catch (error) {
      writeHtml(koaCtx, 400, renderCampusLocationActionPage({
        providerLabel: '校园活动',
        state: 'invalid',
        message: userMessage(error, '定位操作页面加载失败，请稍后重试。'),
      }));
    }
  });

  ctx.server.post(`${actionPagePath}/prepare`, async (koaCtx: any) => {
    const body = await readRequestBody(koaCtx);
    const token = String(body.token ?? '').trim();
    try {
      await service.prepareLocationAction(token, parseLocation(body));
    } catch (error) {
      if (!(error instanceof CampusAuthUserError)) logger.warn('campus action prepare route failed: %s', error instanceof Error ? error.message : String(error));
    }
    writeRedirect(koaCtx, `${actionPagePath}?token=${encodeURIComponent(token)}`);
  });

  ctx.server.post(`${actionPagePath}/commit`, async (koaCtx: any) => {
    const body = await readRequestBody(koaCtx);
    const token = String(body.token ?? '').trim();
    try {
      await service.commitLocationAction(token, parseLocation(body));
    } catch (error) {
      if (!(error instanceof CampusAuthUserError)) logger.warn('campus action commit route failed: %s', error instanceof Error ? error.message : String(error));
    }
    writeRedirect(koaCtx, `${actionPagePath}?token=${encodeURIComponent(token)}`);
  });
}

function queryToken(koaCtx: any): string {
  return String(koaCtx.query?.token ?? koaCtx.request?.query?.token ?? '').trim();
}

function writeHtml(koaCtx: any, status: number, html: string): void {
  koaCtx.status = status;
  koaCtx.set('content-type', 'text/html; charset=utf-8');
  koaCtx.set('cache-control', 'no-store');
  koaCtx.set('referrer-policy', 'no-referrer');
  koaCtx.set('x-frame-options', 'DENY');
  koaCtx.set('content-security-policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  koaCtx.body = html;
}

function writeRedirect(koaCtx: any, location: string): void {
  koaCtx.status = 303;
  koaCtx.set('location', location);
  koaCtx.set('cache-control', 'no-store');
  koaCtx.body = '';
}

async function readRequestBody(koaCtx: any): Promise<Record<string, unknown>> {
  const parsed = koaCtx.request?.body;
  if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  const stream = koaCtx.req as AsyncIterable<Buffer | string> | undefined;
  if (!stream) return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65_536) throw new CampusAuthUserError('请求内容过大。');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return Object.fromEntries(new URLSearchParams(raw));
}

function userMessage(error: unknown, fallback = '绑定处理失败，请稍后重试。'): string {
  if (error instanceof CampusAuthUserError) return error.message;
  logger.warn('campus auth route failed: %s', error instanceof Error ? error.message : String(error));
  return fallback;
}

function parseLocation(body: Record<string, unknown>): { latitude: number; longitude: number; accuracy: number } {
  return {
    latitude: Number(body.latitude),
    longitude: Number(body.longitude),
    accuracy: Number(body.accuracy),
  };
}

function requireAbsolutePath(value: string, key: string): string {
  const path = value.trim();
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) throw new Error(`${key} 配置无效。`);
  return path === '/' ? path : path.replace(/\/+$/, '');
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('campus-auth-core.publicBaseUrl 必须使用 HTTPS；本机地址允许 HTTP。');
  }
  return raw.replace(/\/+$/, '');
}

function positiveInteger(value: number, key: string): number {
  if (!Number.isFinite(value) || value < 1) throw new Error(`${key} 必须是正整数。`);
  return Math.floor(value);
}
