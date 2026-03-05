import { Context, Logger, Schema } from 'koishi';
import * as pokemonBattle from 'koishi-plugin-pokemon-battle';
import { resolvePokemonCommandRoute } from './pokemon-battle-route.js';

export const name = 'pokemon-battle-bridge';

const logger = new Logger(name);
const DEFAULT_IMAGE_SOURCE = 'https://raw.githubusercontent.com/MAIxxxIAM/pokemonFusionImage/main';
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
      if (rendered.length) {
        await session.send(rendered);
      } else {
        logger.warn('pokemon command returned empty response: %s', routedCommand);
        await session.send('宝可梦指令未返回结果，请先发送“宝可梦”查看帮助。');
      }
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
}
