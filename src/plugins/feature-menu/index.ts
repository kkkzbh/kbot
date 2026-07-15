import type { Context, Session } from 'koishi';
import type { NativeFeatureChatServiceLike } from '../../types/native-feature-chat.js';
import '../../types/native-feature-chat.js';
import {
  FeatureIndexMenuService,
  type FeatureIndexMenuPuppeteerLike,
} from './menu.js';

export const name = 'feature-menu';
export const inject = ['nativeFeatureChat', 'puppeteer'] as const;

export interface Config {}

interface FeatureMenuContext {
  nativeFeatureChat: NativeFeatureChatServiceLike;
  puppeteer: FeatureIndexMenuPuppeteerLike;
}

export function apply(ctx: Context, _config: Config = {}): void {
  const services = ctx as unknown as FeatureMenuContext;
  const menuService = new FeatureIndexMenuService(services.puppeteer);

  ctx.middleware(async (session, next) => {
    const text = normalizeCommandText(session);
    if (!isFeatureMenuCommandText(text)) return next();

    const qqUserId = requireQqUserId(session);
    const reply = await menuService.queryMenu(qqUserId);
    await services.nativeFeatureChat.sendReply(session, {
      featureId: 'feature-menu',
      commandId: 'menu',
      userText: text,
      reply,
      summary: '机器人返回了顶级功能菜单图片。',
      success: true,
      includeReplyPayload: true,
    });
  });
}

export function isFeatureMenuCommandText(value: unknown): boolean {
  return String(value ?? '').trim() === '功能';
}

function normalizeCommandText(session: Session): string {
  const carrier = session as Session & { stripped?: { content?: unknown }; content?: unknown };
  return String(carrier.stripped?.content ?? carrier.content ?? '').trim();
}

function requireQqUserId(session: Session): string {
  const qqUserId = String(session.userId ?? '').trim();
  if (!qqUserId) throw new Error('feature menu requires session.userId.');
  return qqUserId;
}
