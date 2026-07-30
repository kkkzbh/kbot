import type { IncomingMessage } from 'node:http';
import { Context, Logger, Schema } from 'koishi';
import { WebSocketLayer, type Server } from '@koishijs/plugin-server';
import {
  AdminAccessPolicy,
  AdminHttpError,
  createRequestId,
} from '../shared/internal-access-policy.js';

type ConsoleWebSocket = Parameters<WebSocketLayer['accept']>[0];

export const name = 'console-access';
export const inject = ['server'] as const;

export interface Config {
  uiPath: string;
  apiPath: string;
  allowedOrigins: string[];
}

export const Config: Schema<Config> = Schema.object({
  uiPath: Schema.string().required(),
  apiPath: Schema.string().required(),
  allowedOrigins: Schema.array(Schema.string()).required(),
});

function readHeader(
  headers: IncomingMessage['headers'],
  name: 'host' | 'tailscale-user-login',
): string {
  const value = headers[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function buildAccessInput(request: IncomingMessage) {
  return {
    host: readHeader(request.headers, 'host'),
    remoteAddress: request.socket.remoteAddress ?? '',
    tailscaleUserLogin: readHeader(request.headers, 'tailscale-user-login'),
  };
}

function normalizeProtectedPath(path: string, key: string): string {
  const normalized = path.trim().replace(/\/+$/, '');
  if (!normalized.startsWith('/') || normalized === '/') {
    throw new Error(`${key} 必须是独立的绝对内部路径。`);
  }
  return normalized;
}

class ConsoleAccessWebSocketLayer extends WebSocketLayer {
  constructor(
    server: Server,
    path: string,
    private readonly policy: AdminAccessPolicy,
    private readonly logger: Logger,
  ) {
    super(server, `${path}(.*)`);
  }

  override accept(socket: ConsoleWebSocket, request: IncomingMessage): true | undefined {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (!this.regexp.test(pathname)) return;
    try {
      this.policy.assertAuthenticatedTransport(buildAccessInput(request));
      return;
    } catch (error) {
      const requestId = createRequestId();
      this.logger.warn(
        'rejected Console WebSocket request %s: %s',
        requestId,
        error instanceof Error ? error.message : String(error),
      );
      socket.close(1008, `Console access denied (${requestId})`);
      return true;
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  const logger = new Logger(name);
  const uiPath = normalizeProtectedPath(config.uiPath, 'uiPath');
  const apiPath = normalizeProtectedPath(config.apiPath, 'apiPath');
  if (apiPath !== uiPath && !apiPath.startsWith(`${uiPath}/`)) {
    throw new Error('Console apiPath 必须位于 uiPath 下。');
  }
  const policy = new AdminAccessPolicy(config.allowedOrigins);

  ctx.server.all(`${uiPath}(.*)`, async (koaCtx, next) => {
    const requestId = createRequestId();
    try {
      policy.assertAuthenticatedTransport({
        host: String(koaCtx.host || koaCtx.request?.host || koaCtx.get?.('host') || '').trim().toLowerCase(),
        remoteAddress: String(koaCtx.req?.socket?.remoteAddress || koaCtx.request?.socket?.remoteAddress || '').trim(),
        tailscaleUserLogin: String(koaCtx.get?.('tailscale-user-login') || '').trim(),
      });
      await next();
    } catch (error) {
      const accessError = error instanceof AdminHttpError
        ? error
        : new AdminHttpError(
            400,
            'bad_request',
            error instanceof Error ? error.message : String(error),
          );
      logger.warn('rejected Console HTTP request %s: %s', requestId, accessError.message);
      koaCtx.status = accessError.status;
      koaCtx.type = 'application/json';
      koaCtx.body = {
        error: {
          code: accessError.code,
          message: accessError.message,
          requestId,
        },
      };
    }
  });

  const websocketGuard = new ConsoleAccessWebSocketLayer(
    ctx.server,
    uiPath,
    policy,
    logger,
  );
  ctx.server.wsStack.unshift(websocketGuard);
  ctx.on('dispose', () => websocketGuard.close());
  logger.info('internal Console guard registered at %s with WebSocket API %s', uiPath, apiPath);
}
