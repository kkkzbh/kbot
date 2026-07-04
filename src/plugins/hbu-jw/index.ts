import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { Context, Logger, Schema } from 'koishi';
import { renderBindPage } from './web/bind-page.js';

export const name = 'hbu-jw';
export const inject = ['server'] as const;

const logger = new Logger(name);
const CAMPUS_BACKGROUND_FILE = join(__dirname, 'assets/campus-bg.jpg');

export interface Config {
  bindPagePath?: string;
  bindPreviewQq?: string;
}

export const Config: Schema<Config> = Schema.object({
  bindPagePath: Schema.string().description('教务绑定页路径。必须以 / 开头。'),
  bindPreviewQq: Schema.string().description('绑定页静态预览 QQ 号。真实绑定流程接入后由绑定 token 解析。'),
});

function requireAbsolutePath(value: unknown, key: string): string {
  const path = String(value ?? '').trim();
  if (!path || !path.startsWith('/')) {
    throw new Error(`${key} 必须配置为以 / 开头的路径。`);
  }
  if (path.includes('?') || path.includes('#')) {
    throw new Error(`${key} 不能包含查询串或 fragment。`);
  }
  return path === '/' ? path : path.replace(/\/+$/, '');
}

function requireQq(value: unknown, key: string): string {
  const qq = String(value ?? '').trim();
  if (!/^[1-9]\d{4,11}$/.test(qq)) {
    throw new Error(`${key} 必须配置为 5 到 12 位 QQ 号。`);
  }
  return qq;
}

export function apply(ctx: Context, config: Config): void {
  const bindPagePath = requireAbsolutePath(config.bindPagePath, 'hbu-jw.bindPagePath');
  const bindPreviewQq = requireQq(config.bindPreviewQq, 'hbu-jw.bindPreviewQq');
  const campusBackgroundStat = statSync(CAMPUS_BACKGROUND_FILE);
  if (!campusBackgroundStat.isFile()) {
    throw new Error(`教务绑定页背景图不存在：${CAMPUS_BACKGROUND_FILE}`);
  }
  const campusBackgroundPath = `${bindPagePath}/assets/campus-bg.jpg`;

  ctx.server.get(bindPagePath, (koaCtx: any) => {
    koaCtx.status = 200;
    koaCtx.set('content-type', 'text/html; charset=utf-8');
    koaCtx.body = renderBindPage({ backgroundImagePath: campusBackgroundPath, qq: bindPreviewQq });
  });

  ctx.server.get(campusBackgroundPath, (koaCtx: any) => {
    koaCtx.status = 200;
    koaCtx.set('content-type', 'image/jpeg');
    koaCtx.set('cache-control', 'public, max-age=86400');
    koaCtx.body = createReadStream(CAMPUS_BACKGROUND_FILE);
  });

  logger.info('HBU JW bind page registered at %s.', bindPagePath);
}
