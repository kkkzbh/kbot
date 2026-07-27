import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { Context, Logger } from 'koishi';
import type {} from '@koishijs/plugin-server';
import { AdminAccessPolicy, AdminHttpError, createRequestId } from './access-policy.js';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const ADMIN_ROUTES = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-180.png',
  '/icon-512.png',
  '/icon.svg',
  '/policies',
  '/assets/(.*)',
  '/runtime',
  '/runtime/(.*)',
  '/intelligence',
  '/intelligence/(.*)',
  '/extensions',
  '/extensions/(.*)',
  '/system',
  '/system/(.*)',
] as const;

function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function registerAdminStatic(options: {
  ctx: Context;
  assetDir: string;
  accessPolicy: AdminAccessPolicy;
  logger: Logger;
}): void {
  const assetDir = resolve(options.assetDir);
  const indexPath = join(assetDir, 'index.html');

  const serveAdminAsset = async (koaCtx: any) => {
    const path = String(koaCtx.path || '');
    const requestId = createRequestId();
    try {
      options.accessPolicy.assertHost(String(koaCtx.host || koaCtx.request?.host || koaCtx.get?.('host') || '').trim().toLowerCase());
      if (koaCtx.method !== 'GET' && koaCtx.method !== 'HEAD') {
        koaCtx.status = 405;
        koaCtx.set('allow', 'GET, HEAD');
        return;
      }

      const requested = decodeURIComponent(path).replace(/^\/+/, '');
      const requestedPath = resolve(assetDir, requested);
      if (relative(assetDir, requestedPath).startsWith('..')) {
        koaCtx.status = 400;
        return;
      }
      const requestedExists = requested && fileExists(requestedPath);
      if (requested && !requestedExists && extname(requested)) {
        koaCtx.status = 404;
        return;
      }
      const target = requestedExists ? requestedPath : indexPath;
      if (!fileExists(target)) {
        throw new AdminHttpError(503, 'service_unavailable', 'Admin SPA 尚未构建，请运行 pnpm build。');
      }
      const extension = extname(target);
      koaCtx.status = 200;
      koaCtx.type = MIME_TYPES[extension] || 'application/octet-stream';
      koaCtx.set('x-content-type-options', 'nosniff');
      koaCtx.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      koaCtx.set('referrer-policy', 'no-referrer');
      koaCtx.set(
        'cache-control',
        target === indexPath
          ? 'no-store'
          : requested.startsWith('assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
      );
      koaCtx.body = koaCtx.method === 'HEAD' ? null : createReadStream(target);
    } catch (error) {
      const adminError = error instanceof AdminHttpError
        ? error
        : new AdminHttpError(400, 'bad_request', error instanceof Error ? error.message : String(error));
      options.logger.warn('admin static request %s failed: %s', requestId, adminError.message);
      koaCtx.status = adminError.status;
      koaCtx.type = 'application/json';
      koaCtx.body = { error: { code: adminError.code, message: adminError.message, requestId } };
    }
  };

  const router = options.ctx.server as any;
  for (const route of ADMIN_ROUTES) {
    router.get(route, serveAdminAsset);
  }
}
