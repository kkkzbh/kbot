import { Context, Logger, Schema } from 'koishi';
import { chmod, copyFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as pokemonBattle from 'koishi-plugin-pokemon-battle';
import { resolvePokemonCommandRoute } from './pokemon-battle-route.js';

export const name = 'pokemon-battle-bridge';
export const inject = ['canvas'];

const logger = new Logger(name);
const DEFAULT_IMAGE_SOURCE = 'https://raw.githubusercontent.com/MAIxxxIAM/pokemonFusionImage/main';
const DEFAULT_DOWNLOADS_OUTPUT = './downloads';
const ZPIX_FONT_FILE = 'zpix.ttf';
const ZPIX_FONT_FAMILY = 'zpix';
const ZPIX_REPAIR_MAX_ATTEMPTS = 24;
const ZPIX_REPAIR_INTERVAL_MS = 5000;
const ROUTE_GUARD_KEY = '__pokemonBattleRouteGuard';

export interface Config {
  enabled?: boolean;
  imageSource?: string;
}

interface PokemonBattleConfig {
  图片源: string;
  QQ官方使用MD: boolean;
  指令使用日志: boolean;
  是否开启文本审核: boolean;
  是否开启友链: boolean;
  签到指令别名: string;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用宝可梦对战插件。'),
  imageSource: Schema.string().role('link').default(DEFAULT_IMAGE_SOURCE).description('宝可梦图片源地址。'),
});

function parseEnabled(raw?: string): boolean | undefined {
  if (raw == null) return undefined;

  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;

  return undefined;
}

function hasRenderableOutput(rendered: unknown): boolean {
  if (rendered == null) return false;
  if (typeof rendered === 'string') return rendered.length > 0;
  if (Array.isArray(rendered)) return rendered.length > 0;

  return true;
}

function resolveDownloadsOutputPath(): string {
  const configured = process.env.POKEMON_DOWNLOADS_OUTPUT?.trim() || DEFAULT_DOWNLOADS_OUTPUT;
  return resolve(process.cwd(), configured);
}

async function ensureDirectoryTraversable(pathname: string): Promise<boolean> {
  const entry = await stat(pathname);
  if (!entry.isDirectory()) return false;

  const currentMode = entry.mode & 0o777;
  const fixedMode = currentMode | 0o111;
  if (fixedMode !== currentMode) {
    await chmod(pathname, fixedMode);
    logger.info('fixed downloads dir mode: %s (%o -> %o)', pathname, currentMode, fixedMode);
  }

  return true;
}

async function ensureFileReadable(pathname: string): Promise<boolean> {
  const entry = await stat(pathname);
  if (!entry.isFile()) return false;

  const currentMode = entry.mode & 0o777;
  const fixedMode = currentMode | 0o444;
  if (fixedMode !== currentMode) {
    await chmod(pathname, fixedMode);
  }

  return true;
}

async function findZpixFontFromDownloads(downloadsRoot: string): Promise<string | null> {
  const entries = await readdir(downloadsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('bucket2-')) continue;

    const bucketPath = resolve(downloadsRoot, entry.name);
    try {
      const traversable = await ensureDirectoryTraversable(bucketPath);
      if (!traversable) continue;

      const fontPath = resolve(bucketPath, ZPIX_FONT_FILE);
      const readable = await ensureFileReadable(fontPath);
      if (!readable) continue;
      return fontPath;
    } catch {
      continue;
    }
  }

  return null;
}

async function copyZpixToProjectRoot(fontPath: string): Promise<void> {
  const target = resolve(process.cwd(), ZPIX_FONT_FILE);
  if (target === fontPath) return;

  try {
    await copyFile(fontPath, target);
    await ensureFileReadable(target);
  } catch {
    // ignore copy failures, registration can still work from downloads path.
  }
}

function registerZpixFont(ctx: Context, fontPath: string): boolean {
  const canvasService = (ctx as any).canvas as { skia?: { FontLibrary?: any } } | undefined;
  const fontLibrary = canvasService?.skia?.FontLibrary;
  if (!fontLibrary?.use) return false;

  try {
    if (typeof fontLibrary.has === 'function' && fontLibrary.has(ZPIX_FONT_FAMILY)) {
      return true;
    }
    fontLibrary.use(ZPIX_FONT_FAMILY, fontPath);
    return true;
  } catch (error) {
    logger.warn('failed to register zpix font: %s (%o)', fontPath, error);
    return false;
  }
}

async function bootstrapZpixFont(ctx: Context): Promise<void> {
  const downloadsRoot = resolveDownloadsOutputPath();
  for (let attempt = 1; attempt <= ZPIX_REPAIR_MAX_ATTEMPTS; attempt++) {
    try {
      const zpixPath = await findZpixFontFromDownloads(downloadsRoot);
      if (zpixPath) {
        await copyZpixToProjectRoot(zpixPath);
        if (registerZpixFont(ctx, zpixPath)) {
          logger.info('zpix font is ready: %s', zpixPath);
          return;
        }
      }
    } catch {
      // keep retrying until timeout.
    }

    await new Promise((resolveRetry) => setTimeout(resolveRetry, ZPIX_REPAIR_INTERVAL_MS));
  }

  logger.warn('zpix font is not ready after retries, pokemon images may show tofu glyphs.');
}

export function apply(ctx: Context, config: Config): void {
  const enabledFromEnv = parseEnabled(process.env.POKEMON_BATTLE_ENABLED);
  const isCi = String(process.env.CI ?? '').toLowerCase() === 'true';
  const enabled = enabledFromEnv ?? config.enabled ?? !isCi;

  ctx.middleware(async (session, next) => {
    if (!enabled) return next();
    if ((session as any)[ROUTE_GUARD_KEY]) return next();

    const content = session.stripped?.content?.trim() || session.content?.trim() || '';
    const routedCommand = resolvePokemonCommandRoute(content);
    if (!routedCommand) return next();

    // 宝可梦关键词优先：命中后直接进入游戏命令链路，避免被普通聊天中间件吞掉。
    (session as any)[ROUTE_GUARD_KEY] = true;
    try {
      const rendered = await session.execute(routedCommand, true);
      if (hasRenderableOutput(rendered)) {
        await session.send(rendered);
      } else {
        logger.warn('pokemon command returned empty response: %s', routedCommand);
        await session.send('宝可梦指令未返回结果，请先发送“宝可梦”查看帮助。');
      }
    } catch (error) {
      logger.warn('pokemon command failed: %s (%o)', routedCommand, error);
      await session.send('宝可梦指令执行异常，请稍后重试。');
    } finally {
      delete (session as any)[ROUTE_GUARD_KEY];
    }
  });

  if (!enabled) {
    logger.info('pokemon-battle is disabled by config/env.');
    return;
  }

  const imageSource = process.env.POKEMON_BATTLE_IMAGE_SOURCE?.trim() || config.imageSource?.trim() || DEFAULT_IMAGE_SOURCE;
  const pluginConfig: PokemonBattleConfig = {
    图片源: imageSource,
    QQ官方使用MD: false,
    指令使用日志: false,
    是否开启文本审核: false,
    是否开启友链: false,
    签到指令别名: '宝可梦签到',
  };

  logger.info('pokemon-battle enabled, image source: %s', imageSource);
  // Upstream typings mark many internal fields as required, but runtime accepts partial config.
  ctx.plugin(pokemonBattle as any, pluginConfig as any);
  void bootstrapZpixFont(ctx);
}
