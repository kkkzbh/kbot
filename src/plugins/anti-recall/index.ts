import { Context, h, Logger, Schema, type Element, type Session } from 'koishi';
import { AntiRecallMessageCache, type AntiRecallMessageEntry } from './cache.js';

export const name = 'anti-recall';

const logger = new Logger(name);

export interface Config {
  enabled?: boolean;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().description('检测到消息撤回后，发送头像、QQ 号和原消息。'),
});

function requireEnabled(config: Config): boolean {
  if (typeof config.enabled !== 'boolean') {
    throw new Error('防撤回配置缺失：enabled 必须由 koishi.yml 显式传入。');
  }
  return config.enabled;
}

export function qqAvatarUrl(userId: string): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(userId)}&s=100`;
}

export function buildAntiRecallNotice(entry: AntiRecallMessageEntry): Element[] {
  const original = h.parse(entry.content).filter((element) => element.type !== 'quote');
  return [
    h.image(qqAvatarUrl(entry.userId)),
    h.text(`[${entry.userId}]撤回了一条消息: `),
    ...original,
  ];
}

export function apply(ctx: Context, config: Config = {}): void {
  const enabled = requireEnabled(config);
  if (!enabled) {
    logger.info('anti-recall is disabled.');
    return;
  }
  const messageCache = new AntiRecallMessageCache();

  ctx.middleware(async (session, next) => {
    messageCache.capture(session);
    return next();
  });

  ctx.on('message-deleted', async (session: Session) => {
    const entry = messageCache.find(session);
    if (!entry) {
      logger.info(
        'anti-recall skipped an unavailable message: platform=%s channelId=%s messageId=%s userId=%s',
        session.platform,
        session.channelId ?? '<unknown>',
        session.messageId ?? '<unknown>',
        session.userId ?? '<unknown>',
      );
      return;
    }

    await session.send(buildAntiRecallNotice(entry));
    messageCache.delete(entry.key);
  });

  ctx.on('dispose', () => {
    messageCache.clear();
  });
}
