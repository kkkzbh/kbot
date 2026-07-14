import { Context, Logger, Schema } from 'koishi';
import QRCode from 'qrcode';
import type { CampusAuthServiceLike } from '../../types/campus-auth.js';
import '../../types/campus-auth.js';
import { loadOrCreateKek, resolveKekPath } from '../shared/credential-crypto.js';
import { renderCampusAppBridgePage } from './app-bridge-page.js';
import { renderCampusBindPage } from './bind-page.js';
import { CampusAuthService } from './service.js';
import { ensureCampusAuthTables, CampusAuthStore } from './store.js';
import type { CampusAuthDatabase, CampusAuthMethod, CampusAuthProvider } from './types.js';
import { CampusAuthUserError } from './types.js';

export * from './types.js';
export { CampusAuthService } from './service.js';

export const name = 'campus-auth-core';
export const inject = ['server', 'database'] as const;

const logger = new Logger(name);
const DEFAULT_BIND_PAGE_PATH = '/campus/bind';
const DEFAULT_BIND_TOKEN_TTL_MS = 600_000;
const DEFAULT_MAX_BINDING_ATTEMPTS = 5;

export interface Config {
  publicBaseUrl?: string;
  bindPagePath?: string;
  bindTokenTtlMs?: number;
  credentialKekPath?: string;
  maxBindingAttempts?: number;
}

export const Config: Schema<Config> = Schema.object({
  publicBaseUrl: Schema.string().description('校园账号绑定页的外部 HTTPS 基础地址。'),
  bindPagePath: Schema.string().default(DEFAULT_BIND_PAGE_PATH).description('统一校园账号绑定页路径。'),
  bindTokenTtlMs: Schema.natural().role('time').default(DEFAULT_BIND_TOKEN_TTL_MS).description('一次性绑定链接有效期。'),
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
  const maxBindingAttempts = positiveInteger(config.maxBindingAttempts ?? DEFAULT_MAX_BINDING_ATTEMPTS, 'campus-auth-core.maxBindingAttempts');
  const baseDir = String((ctx as { baseDir?: string }).baseDir ?? process.cwd());
  const kekPath = resolveKekPath(baseDir, config.credentialKekPath ?? './.runtime/campus-auth/credential-kek.key');

  ensureCampusAuthTables(ctx);
  const service = new CampusAuthService(
    new CampusAuthStore(serviceCtx.database),
    loadOrCreateKek(kekPath),
    { publicBaseUrl, bindPagePath, bindTokenTtlMs, maxBindingAttempts },
  );
  provideService(ctx, service);
  registerRoutes(serviceCtx, service, bindPagePath, publicBaseUrl);
  ctx.on?.('ready', () => service.cleanupExpiredChallenges());
  logger.info('campus auth bind page registered at %s.', bindPagePath);
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

function registerRoutes(ctx: CampusAuthContext, service: CampusAuthService, bindPagePath: string, publicBaseUrl: string): void {
  const appBridgePath = `${bindPagePath}/app-bridge`;
  const appBridgeSubmitPath = `${appBridgePath}/submit`;
  ctx.server.get(bindPagePath, async (koaCtx: any) => {
    const token = queryToken(koaCtx);
    try {
      const state = await service.resolveBindPage(token);
      const methods = state.state === 'form' ? await state.provider.getBindingMethods() : [];
      const appBridge = state.state === 'form'
        ? await createAppBridgeView(state.provider, token, publicBaseUrl, appBridgePath)
        : undefined;
      writeHtml(koaCtx, 200, renderCampusBindPage({
        providerId: state.provider.id,
        providerLabel: state.provider.label,
        qqUserId: state.challenge.qqUserId,
        token,
        submitPath: `${bindPagePath}/submit`,
        methods,
        appBridge,
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

  ctx.server.get(appBridgePath, async (koaCtx: any) => {
    const token = queryToken(koaCtx);
    try {
      const state = await service.resolveBindPage(token);
      if (state.state !== 'form') throw new CampusAuthUserError('当前绑定流程无需再次调用 App 授权。');
      if (!state.provider.appBridge) throw new CampusAuthUserError('当前模块不支持 App 扫码授权。');
      writeHtml(koaCtx, 200, renderCampusAppBridgePage({
        providerLabel: state.provider.label,
        token,
        submitPath: appBridgeSubmitPath,
        returnPath: `${bindPagePath}?token=${encodeURIComponent(token)}`,
      }));
    } catch (error) {
      writeHtml(koaCtx, 400, renderCampusAppBridgePage({
        providerLabel: '校园账号',
        state: 'invalid',
        message: userMessage(error),
      }));
    }
  });

  ctx.server.post(appBridgeSubmitPath, async (koaCtx: any) => {
    const body = await readRequestBody(koaCtx);
    const token = String(body.token ?? '').trim();
    try {
      await service.submitAppBridgeBinding(token, String(body.code ?? ''));
      writeJson(koaCtx, 200, { ok: true });
    } catch (error) {
      writeJson(koaCtx, 400, { ok: false, message: userMessage(error) });
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
          appBridge: state.state === 'form'
            ? await createAppBridgeView(state.provider, token, publicBaseUrl, appBridgePath)
            : undefined,
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
}

async function createAppBridgeView(
  provider: CampusAuthProvider,
  token: string,
  publicBaseUrl: string,
  appBridgePath: string,
): Promise<{ label: string; description: string; qrImageDataUrl: string } | undefined> {
  if (!provider.appBridge) return undefined;
  return {
    label: provider.appBridge.label,
    description: provider.appBridge.description,
    qrImageDataUrl: await QRCode.toDataURL(
      `${publicBaseUrl}${appBridgePath}?token=${encodeURIComponent(token)}`,
      { errorCorrectionLevel: 'M', margin: 2, width: 280 },
    ),
  };
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
  koaCtx.set('content-security-policy', "default-src 'none'; connect-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  koaCtx.body = html;
}

function writeJson(koaCtx: any, status: number, value: unknown): void {
  koaCtx.status = status;
  koaCtx.set('content-type', 'application/json; charset=utf-8');
  koaCtx.set('cache-control', 'no-store');
  koaCtx.set('referrer-policy', 'no-referrer');
  koaCtx.body = JSON.stringify(value);
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
    if (size > 65_536) throw new CampusAuthUserError('绑定请求内容过大。');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return Object.fromEntries(new URLSearchParams(raw));
}

function userMessage(error: unknown): string {
  if (error instanceof CampusAuthUserError) return error.message;
  logger.warn('campus auth route failed: %s', error instanceof Error ? error.message : String(error));
  return '绑定处理失败，请稍后重试。';
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
