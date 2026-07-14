import { parseExpression } from 'cron-parser';
import { Context, h, Logger, Schema, type Fragment, type Session } from 'koishi';
import QRCode from 'qrcode';
import type { NativeFeatureChatServiceLike } from '../../types/native-feature-chat.js';
import '../../types/native-feature-chat.js';
import { loadOrCreateKek, resolveKekPath } from '../shared/credential-crypto.js';
import { normalizeGroupId, parseGroupSet } from '../shared/group-id.js';
import { GenshinGachaService, renderGenshinGachaRecordsImage } from './gacha-records.js';
import { GenshinGachaIconResolver } from './gacha-icon-resolver.js';
import { GenshinMenuService, type GenshinMenuPuppeteerLike } from './menu.js';
import { GenshinService, type QrBindingStatusResult } from './service.js';
import { ensureGenshinTables, GenshinStore } from './store.js';
import { GenshinTakumiClient } from './takumi-client.js';
import { GenshinUserError, type DatabaseLike, type GenshinGameRole, type OwnerIdentity } from './types.js';
import { renderGenshinBindPage, renderGenshinBindSuccessFragment } from './web/bind-page.js';

export const name = 'genshin';
export const inject = ['server', 'database', 'puppeteer', 'nativeFeatureChat'] as const;

const logger = new Logger(name);
const DEFAULT_BIND_PAGE_PATH = '/genshin/bind';
const DEFAULT_BIND_TOKEN_TTL_MS = 600_000;
const DEFAULT_AUTO_SIGN_CRON = '10 9 * * *';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_ACT_ID = 'e202311201442471';
const DEFAULT_APP_VERSION = '2.70.1';
const DEFAULT_REDEEM_GAME_VERSION = 'CNRELWin6.0.0';
const DEFAULT_GACHA_REQUEST_INTERVAL_MS = 1_200;
const DEFAULT_GACHA_ICON_CACHE_PATH = './.runtime/genshin/gacha-icon-cache.json';

export interface Config {
  bindPagePath?: string;
  publicBaseUrl?: string;
  bindTokenTtlMs?: number;
  credentialKekPath?: string;
  autoSignEnabled?: boolean;
  autoSignCron?: string;
  timezone?: string;
  takumiAppVersion?: string;
  signActId?: string;
  redeemGameVersion?: string;
  gachaRequestIntervalMs?: number;
  gachaIconCachePath?: string;
  allowedGroups?: string[] | string;
  naturalTriggerEnabled?: boolean;
  naturalTriggerGroups?: string[] | string;
}

export const Config: Schema<Config> = Schema.object({
  bindPagePath: Schema.string().default(DEFAULT_BIND_PAGE_PATH).description('原神绑定页路径。必须以 / 开头。'),
  publicBaseUrl: Schema.string().description('群聊或私聊回复中使用的外部可访问基础 URL。'),
  bindTokenTtlMs: Schema.natural().role('time').default(DEFAULT_BIND_TOKEN_TTL_MS).description('绑定链接有效期。'),
  credentialKekPath: Schema.string().description('原神凭据 KEK 文件路径。文件必须为 0600 权限。'),
  autoSignEnabled: Schema.boolean().default(true).description('是否启用原神每日自动签到。'),
  autoSignCron: Schema.string().default(DEFAULT_AUTO_SIGN_CRON).description('自动签到 cron 表达式。'),
  timezone: Schema.string().default(DEFAULT_TIMEZONE).description('自动签到时区。'),
  takumiAppVersion: Schema.string().default(DEFAULT_APP_VERSION).description('米游社请求头 x-rpc-app_version。'),
  signActId: Schema.string().default(DEFAULT_ACT_ID).description('原神签到活动 act_id。'),
  redeemGameVersion: Schema.string().default(DEFAULT_REDEEM_GAME_VERSION).description('兑换码接口 game_version。'),
  gachaRequestIntervalMs: Schema.natural().role('time').default(DEFAULT_GACHA_REQUEST_INTERVAL_MS).description('抽卡记录分页请求间隔，用于控制米游社接口访问频率。'),
  gachaIconCachePath: Schema.string().default(DEFAULT_GACHA_ICON_CACHE_PATH).description('抽卡记录物品图标运行时缓存文件路径。'),
  allowedGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('允许使用原神功能的群号列表。只限制群聊，私聊仍允许使用。'),
    Schema.string().description('允许使用原神功能的群号，多个群号用英文逗号分隔。只限制群聊，私聊仍允许使用。'),
  ]),
  naturalTriggerEnabled: Schema.boolean().default(false).description('是否允许自然触发白名单群聊裸触发原神命令。'),
  naturalTriggerGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('允许群聊裸触发原神命令的自然触发白名单群号列表。'),
    Schema.string().description('允许群聊裸触发原神命令的自然触发白名单群号，多个群号用英文逗号分隔。'),
  ]),
});

interface GenshinServicesLike {
  database: DatabaseLike;
  nativeFeatureChat: NativeFeatureChatServiceLike;
  puppeteer: GenshinMenuPuppeteerLike;
  server: {
    get(path: string, handler: (koaCtx: any) => unknown): void;
    post(path: string, handler: (koaCtx: any) => unknown): void;
    use?(handler: (koaCtx: any, next: () => Promise<unknown>) => unknown): void;
  };
}

interface RuntimeConfig {
  bindPagePath: string;
  publicBaseUrl: string;
  bindTokenTtlMs: number;
  credentialKekPath: string;
  bindSubmitPath: string;
  bindStatusPath: string;
  publicHostGuard: string | null;
  autoSignEnabled: boolean;
  autoSignCron: string;
  timezone: string;
  takumiAppVersion: string;
  signActId: string;
  redeemGameVersion: string;
  gachaRequestIntervalMs: number;
  gachaIconCachePath: string;
  allowedGroups: Set<string>;
  naturalTriggerEnabled: boolean;
  naturalTriggerGroups: Set<string>;
}

export function apply(ctx: Context, config: Config): void {
  const runtime = resolveRuntimeConfig(ctx, config);
  const genshinCtx = ctx as unknown as GenshinServicesLike;
  ensureGenshinTables(ctx);

  const kek = loadOrCreateKek(runtime.credentialKekPath);
  const store = new GenshinStore(genshinCtx.database);
  const client = new GenshinTakumiClient({
    appVersion: runtime.takumiAppVersion,
    actId: runtime.signActId,
    redeemGameVersion: runtime.redeemGameVersion,
  });
  const service = new GenshinService(store, client, kek, {
    bindPagePath: runtime.bindPagePath,
    publicBaseUrl: runtime.publicBaseUrl,
    bindTokenTtlMs: runtime.bindTokenTtlMs,
    timezone: runtime.timezone,
  });
  const menuService = new GenshinMenuService(genshinCtx.puppeteer);
  const iconResolver = new GenshinGachaIconResolver({
    cachePath: runtime.gachaIconCachePath,
  });
  const gachaService = new GenshinGachaService(store, client, kek, {
    timezone: runtime.timezone,
    requestIntervalMs: runtime.gachaRequestIntervalMs,
    iconResolver,
  });

  const unregisterCapability = genshinCtx.nativeFeatureChat.registerCapability({
    id: 'genshin',
    buildReference: (session) => buildGenshinCapabilityReference(session, runtime),
  });
  ctx.on?.('dispose', unregisterCapability);

  registerHostGuard(genshinCtx, runtime);
  registerWebRoutes(genshinCtx, service, runtime);
  registerKeywordMiddleware(
    ctx,
    service,
    menuService,
    gachaService,
    genshinCtx.puppeteer,
    genshinCtx.nativeFeatureChat,
    runtime,
  );
  registerAutoSign(ctx, service, runtime);

  ctx.on?.('ready', async () => {
    await store.cleanupExpiredChallenges(Date.now());
  });

  logger.info('Genshin bind page registered at %s.', runtime.bindPagePath);
}

function resolveRuntimeConfig(ctx: Context, config: Config): RuntimeConfig {
  const bindPagePath = requireAbsolutePath(config.bindPagePath ?? DEFAULT_BIND_PAGE_PATH, 'genshin.bindPagePath');
  const publicBaseUrl = normalizeBaseUrl(config.publicBaseUrl ?? `http://127.0.0.1:${process.env.KOISHI_PORT || '5140'}`, 'genshin.publicBaseUrl');
  const credentialKekPath = resolveKekPath(String((ctx as { baseDir?: string }).baseDir ?? process.cwd()), config.credentialKekPath ?? './.runtime/genshin/credential-kek.key');
  const gachaIconCachePath = resolveKekPath(String((ctx as { baseDir?: string }).baseDir ?? process.cwd()), config.gachaIconCachePath ?? DEFAULT_GACHA_ICON_CACHE_PATH);
  return {
    bindPagePath,
    publicBaseUrl,
    bindTokenTtlMs: requirePositiveInteger(config.bindTokenTtlMs ?? DEFAULT_BIND_TOKEN_TTL_MS, 'genshin.bindTokenTtlMs'),
    credentialKekPath,
    bindSubmitPath: `${bindPagePath}/submit`,
    bindStatusPath: `${bindPagePath}/status`,
    publicHostGuard: resolvePublicHostGuard(publicBaseUrl),
    gachaIconCachePath,
    autoSignEnabled: config.autoSignEnabled ?? true,
    autoSignCron: requireNonEmptyString(config.autoSignCron ?? DEFAULT_AUTO_SIGN_CRON, 'genshin.autoSignCron'),
    timezone: requireNonEmptyString(config.timezone ?? DEFAULT_TIMEZONE, 'genshin.timezone'),
    takumiAppVersion: requireNonEmptyString(config.takumiAppVersion ?? DEFAULT_APP_VERSION, 'genshin.takumiAppVersion'),
    signActId: requireNonEmptyString(config.signActId ?? DEFAULT_ACT_ID, 'genshin.signActId'),
    redeemGameVersion: requireNonEmptyString(config.redeemGameVersion ?? DEFAULT_REDEEM_GAME_VERSION, 'genshin.redeemGameVersion'),
    gachaRequestIntervalMs: requirePositiveInteger(config.gachaRequestIntervalMs ?? DEFAULT_GACHA_REQUEST_INTERVAL_MS, 'genshin.gachaRequestIntervalMs'),
    allowedGroups: requireAllowedGroups(config.allowedGroups, 'genshin.allowedGroups'),
    naturalTriggerEnabled: config.naturalTriggerEnabled === true,
    naturalTriggerGroups: parseGroupSet(config.naturalTriggerGroups ?? ''),
  };
}

function registerHostGuard(ctx: GenshinServicesLike, runtime: RuntimeConfig): void {
  if (!runtime.publicHostGuard || typeof ctx.server.use !== 'function') return;
  const allowedPaths = new Set([runtime.bindPagePath, runtime.bindSubmitPath, runtime.bindStatusPath]);
  ctx.server.use(async (koaCtx: any, next: () => Promise<unknown>) => {
    const host = String(koaCtx.host ?? koaCtx.hostname ?? koaCtx.get?.('host') ?? koaCtx.request?.headers?.host ?? '').trim().toLowerCase();
    if (host !== runtime.publicHostGuard) {
      return next();
    }
    const path = String(koaCtx.path ?? koaCtx.request?.path ?? '').trim();
    if (allowedPaths.has(path)) {
      return next();
    }
    koaCtx.status = 404;
    koaCtx.body = 'Not Found';
    return undefined;
  });
}

function registerWebRoutes(ctx: GenshinServicesLike, service: GenshinService, runtime: RuntimeConfig): void {
  ctx.server.get(runtime.bindPagePath, async (koaCtx: any) => {
    const token = String(koaCtx.query?.token ?? koaCtx.request?.query?.token ?? '').trim();
    try {
      const challenge = await service.resolveBindPageChallenge(token);
      const qrImageDataUrl = challenge.state === 'qr' && challenge.qrUrl
        ? await QRCode.toDataURL(challenge.qrUrl, { errorCorrectionLevel: 'M', margin: 2, width: 280 })
        : undefined;
      writeHtml(koaCtx, 200, renderGenshinBindPage({
        qq: challenge.qqUserId,
        token: challenge.token,
        submitPath: runtime.bindSubmitPath,
        statusPath: `${runtime.bindStatusPath}?token=${encodeURIComponent(token)}`,
        state: challenge.state,
        qrImageDataUrl,
        roles: challenge.roles,
      }));
    } catch (error) {
      writeHtml(koaCtx, 400, renderGenshinBindPage({
        qq: '',
        state: 'invalid',
        message: toUserMessage(error),
      }));
    }
  });

  ctx.server.get(runtime.bindStatusPath, async (koaCtx: any) => {
    const token = String(koaCtx.query?.token ?? koaCtx.request?.query?.token ?? '').trim();
    try {
      writeJson(koaCtx, 200, bindStatusResponse(await service.pollQrLogin(token)));
    } catch (error) {
      writeJson(koaCtx, 400, {
        kind: 'error',
        message: toUserMessage(error),
      });
    }
  });

  ctx.server.post(runtime.bindSubmitPath, async (koaCtx: any) => {
    const body = await readRequestBody(koaCtx);
    const token = String(body.token ?? '').trim();
    let qq = '';
    try {
      const challenge = await service.resolveBindPageChallenge(token);
      qq = challenge.qqUserId;
      const result = await service.selectRole({
        token,
        selectedRoleKey: String(body.selectedRoleKey ?? ''),
      });
      if (result.kind === 'role_selection') {
        writeHtml(koaCtx, 200, renderGenshinBindPage({
          qq: result.qqUserId,
          token,
          submitPath: runtime.bindSubmitPath,
          state: 'role_selection',
          roles: result.roles,
        }));
        return;
      }
      writeHtml(koaCtx, 200, renderGenshinBindPage({
        qq: result.qqUserId,
        state: 'success',
        confirmCode: result.confirmCode,
        role: result.role,
      }));
    } catch (error) {
      writeHtml(koaCtx, 400, renderGenshinBindPage({
        qq,
        token,
        submitPath: runtime.bindSubmitPath,
        state: qq ? 'error' : 'invalid',
        message: toUserMessage(error),
      }));
    }
  });
}

function bindStatusResponse(result: QrBindingStatusResult): Record<string, unknown> {
  if (result.kind === 'success') {
    const confirmCommand = `原神确认 ${result.confirmCode}`;
    return {
      kind: 'success',
      html: renderGenshinBindSuccessFragment(confirmCommand, roleDisplayText(result.role)),
    };
  }
  if (result.kind === 'role_selection') {
    return {
      kind: 'role_selection',
      roles: result.roles.map((role) => ({
        uid: role.uid,
        region: role.region,
        regionName: role.regionName,
        nickname: role.nickname,
        level: role.level,
      })),
    };
  }
  return result;
}

function registerKeywordMiddleware(
  ctx: Context,
  service: GenshinService,
  menuService: GenshinMenuService,
  gachaService: GenshinGachaService,
  puppeteer: GenshinMenuPuppeteerLike,
  nativeFeatureChat: NativeFeatureChatServiceLike,
  runtime: RuntimeConfig,
): void {
  ctx.middleware(async (session, next) => {
    const text = normalizeCommandText(session);
    const command = parseGenshinCommand(text);
    if (!command) return next();

    if (command.kind !== 'gacha_records' && !canInvokeGenshinInSession(session, runtime.naturalTriggerEnabled, runtime.naturalTriggerGroups)) {
      return next();
    }

    if (!canUseGenshinInSession(session, runtime.allowedGroups)) {
      await sendGenshinReply(nativeFeatureChat, session, command, text, '当前群未开启原神功能。', {
        summary: '机器人说明当前群未开启原神功能。',
        success: false,
      });
      return;
    }

    if (command.kind === 'menu') {
      try {
        const identity = resolveOwnerIdentity(session);
        await sendGenshinReply(nativeFeatureChat, session, command, text, await menuService.queryMenu(identity.qqUserId), {
          summary: '机器人返回了原神功能菜单图片。',
        });
      } catch (error) {
        await sendGenshinError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'bind') {
      try {
        const identity = resolveOwnerIdentity(session);
        const result = await service.startBinding(identity);
        await sendGenshinReply(nativeFeatureChat, session, command, text, createMentionedReply(identity.qqUserId, `请打开链接完成原神 UID 绑定：\n${result.link}\n链接 10 分钟内有效。\n\n页面验证通过后会显示 6 位确认码。请回到这里发送：\n原神确认 <确认码>\n完成绑定。`), {
          summary: '机器人提供了原神绑定流程；一次性绑定链接未写入历史。',
          includeReplyPayload: false,
        });
      } catch (error) {
        await sendGenshinError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'confirm_help') {
      await sendGenshinReply(nativeFeatureChat, session, command, text, '请发送完整确认命令：原神确认 <6位确认码>。确认码会在绑定页验证通过后显示。', {
        summary: '机器人说明原神确认码必须是 6 位数字。',
      });
      return;
    }

    if (command.kind === 'confirm') {
      try {
        const identity = resolveOwnerIdentity(session);
        const role = await service.confirmBinding(identity, command.confirmCode);
        await sendGenshinReply(nativeFeatureChat, session, command, text, createMentionedReply(identity.qqUserId, `原神绑定完成：UID ${role.uid}。`, 'space'), {
          summary: `原神绑定完成：UID ${role.uid}。`,
        });
      } catch (error) {
        await sendGenshinError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'sign') {
      try {
        const identity = resolveOwnerIdentity(session);
        const result = await service.manualSignIn(identity);
        const reply = formatSignReply(result.role, result.status, result.message, result.totalSignDay);
        await sendGenshinReply(nativeFeatureChat, session, command, text, reply, {
          summary: reply,
        });
      } catch (error) {
        await sendGenshinError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'redeem_help') {
      await sendGenshinReply(nativeFeatureChat, session, command, text, '请发送：原神兑换 <兑换码>。', {
        summary: '机器人说明原神兑换命令需要 6 至 32 位字母或数字兑换码。',
      });
      return;
    }

    if (command.kind === 'redeem') {
      try {
        const identity = resolveOwnerIdentity(session);
        const result = await service.redeemCode(identity, command.cdkey);
        const reply = formatRedeemReply(result.role, result.message);
        await sendGenshinReply(nativeFeatureChat, session, command, text, reply, {
          summary: `机器人返回了 UID ${result.role.uid} 的兑换结果；兑换码未写入历史。`,
        });
      } catch (error) {
        await sendGenshinError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'gacha_records') {
      try {
        const identity = resolveOwnerIdentity(session);
        const view = await gachaService.queryGachaRecords(identity);
        await sendGenshinReply(nativeFeatureChat, session, command, text, [
          h.at(identity.qqUserId),
          h.text('\n'),
          await renderGenshinGachaRecordsImage(puppeteer, view),
        ], {
          summary: `机器人返回了 UID ${view.uid} 的抽卡记录统计图片。`,
        });
      } catch (error) {
        await sendGenshinError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'unbind') {
      try {
        const identity = resolveOwnerIdentity(session);
        await service.unbind(identity);
        await sendGenshinReply(nativeFeatureChat, session, command, text, '原神绑定已解除。', {
          summary: '原神绑定已解除。',
        });
      } catch (error) {
        await sendGenshinError(nativeFeatureChat, session, command, text, error);
      }
    }
  });
}

function registerAutoSign(ctx: Context, service: GenshinService, runtime: RuntimeConfig): void {
  if (!runtime.autoSignEnabled) return;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const scheduleNext = () => {
    if (disposed) return;
    let nextAt: number;
    try {
      nextAt = parseExpression(runtime.autoSignCron, { currentDate: new Date(), tz: runtime.timezone }).next().getTime();
    } catch (error) {
      logger.warn('invalid genshin auto sign cron "%s": %s', runtime.autoSignCron, error instanceof Error ? error.message : String(error));
      return;
    }
    const tick = () => {
      if (disposed) return;
      const remaining = nextAt - Date.now();
      if (remaining > 0) {
        timer = setTimeout(tick, Math.min(remaining, 0x7fffffff));
        timer.unref?.();
        return;
      }
      scheduleNext();
      service.runAutoSignIn().catch((error) => {
        logger.warn('genshin auto sign run failed: %s', error instanceof Error ? error.message : String(error));
      });
    };
    tick();
  };

  scheduleNext();
  ctx.on?.('dispose', () => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
}

function createMentionedReply(qqUserId: string, content: string, separator: 'newline' | 'space' = 'newline'): Fragment {
  return [h.at(qqUserId), h.text(`${separator === 'newline' ? '\n' : ' '}${content}`)];
}

function formatSignReply(role: GenshinGameRole, status: string, message: string, totalSignDay: number | null): string {
  const dayText = totalSignDay == null ? '' : `，累计签到 ${totalSignDay} 天`;
  if (status === 'already_done') {
    return `今天已经签到过了：UID ${role.uid}${dayText}。`;
  }
  return `原神签到完成：UID ${role.uid}${dayText}。${message && message !== 'OK' ? `\n${message}` : ''}`;
}

function formatRedeemReply(role: GenshinGameRole, message: string): string {
  return `原神兑换码领取完成：UID ${role.uid}。\n${message}`;
}

function roleDisplayText(role: GenshinGameRole): string {
  return `${role.nickname || '旅行者'} / UID ${role.uid} / ${role.regionName || role.region}`;
}

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

function normalizeBaseUrl(value: unknown, key: string): string {
  const raw = String(value ?? '').trim();
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !isLocalHttpUrl(url)) {
    throw new Error(`${key} 必须是 https URL；只有 127.0.0.1、localhost 和 ::1 允许使用 http。`);
  }
  return raw.replace(/\/+$/, '');
}

function isLocalHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

function resolvePublicHostGuard(publicBaseUrl: string): string | null {
  const url = new URL(publicBaseUrl);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  return url.host.toLowerCase();
}

function requirePositiveInteger(value: unknown, key: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${key} 必须是正整数。`);
  }
  return Math.floor(parsed);
}

function requireAllowedGroups(value: unknown, key: string): Set<string> {
  if (value == null) {
    throw new Error(`${key} 必须显式配置。`);
  }
  return parseGroupSet(value as string[] | string);
}

function requireNonEmptyString(value: unknown, key: string): string {
  const parsed = String(value ?? '').trim();
  if (!parsed) {
    throw new Error(`${key} 必须配置。`);
  }
  return parsed;
}

function normalizeCommandText(session: Session): string {
  const carrier = session as Session & { stripped?: { content?: unknown }; content?: unknown };
  return String(carrier.stripped?.content ?? carrier.content ?? '').trim();
}

type GenshinCommand =
  | { kind: 'menu' }
  | { kind: 'bind' }
  | { kind: 'confirm_help' }
  | { kind: 'confirm'; confirmCode: string }
  | { kind: 'sign' }
  | { kind: 'redeem_help' }
  | { kind: 'redeem'; cdkey: string }
  | { kind: 'gacha_records' }
  | { kind: 'unbind' };

interface GenshinHistoryReplyOptions {
  summary: string;
  success?: boolean;
  includeReplyPayload?: boolean;
}

function genshinHistoryUserText(command: GenshinCommand, text: string): string {
  if (command.kind === 'confirm') return '原神确认 <确认码已隐藏>';
  if (command.kind === 'redeem') return '原神兑换 <兑换码已隐藏>';
  return text;
}

async function sendGenshinReply(
  nativeFeatureChat: NativeFeatureChatServiceLike,
  session: Session,
  command: GenshinCommand,
  text: string,
  reply: Fragment,
  options: GenshinHistoryReplyOptions,
): Promise<void> {
  await nativeFeatureChat.sendReply(session, {
    featureId: 'genshin',
    commandId: command.kind,
    userText: genshinHistoryUserText(command, text),
    reply,
    summary: options.summary,
    success: options.success ?? true,
    includeReplyPayload: options.includeReplyPayload ?? true,
  });
}

async function sendGenshinError(
  nativeFeatureChat: NativeFeatureChatServiceLike,
  session: Session,
  command: GenshinCommand,
  text: string,
  error: unknown,
): Promise<void> {
  const message = toUserMessage(error);
  const sensitiveValue = command.kind === 'confirm'
    ? command.confirmCode
    : command.kind === 'redeem'
      ? command.cdkey
      : null;
  const historyMessage = sensitiveValue
    ? message.replaceAll(sensitiveValue, command.kind === 'confirm' ? '<确认码已隐藏>' : '<兑换码已隐藏>')
    : message;
  await sendGenshinReply(nativeFeatureChat, session, command, text, message, {
    summary: `原神功能未完成：${historyMessage}`,
    success: false,
    includeReplyPayload: sensitiveValue == null,
  });
}

export function buildGenshinCapabilityReference(session: Session, runtime: RuntimeConfig): string {
  const enabled = canUseGenshinInSession(session, runtime.allowedGroups);
  const direct = session.isDirect === true;
  const groupId = normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
  const bareEnabled = direct || (
    runtime.naturalTriggerEnabled
    && Boolean(groupId && runtime.naturalTriggerGroups.has(groupId))
  );
  const invocation = direct || bareEnabled
    ? '直接发送下面的命令。'
    : '除抽卡记录外，群聊中需要 @机器人 后发送下面的命令。';

  return [
    `原神功能（当前会话${enabled ? '可用' : '未启用'}）：${invocation}`,
    '- 总入口：“原神”，返回完整原神菜单。',
    '- 账号：“原神绑定”、“原神确认 <6位数字确认码>”、“原神解绑”。',
    '- 日常：“原神签到”、“原神兑换 <兑换码>”；兑换码只接受 6 至 32 位字母或数字。',
    '- 记录：“抽卡记录”或“原神抽卡记录”，同步并返回当前绑定 UID 的抽卡统计；允许在已启用群聊中直接发送。',
    '- 功能面向米游社国服原神 UID，查询和操作前需要先完成绑定。',
    enabled
      ? '- 用户写成自然语言或格式错误时，纠正并给出最贴近意图的上述准确命令。'
      : '- 当前群未开启原神功能；说明不可用，不要引导用户反复尝试。',
  ].join('\n');
}

function parseGenshinCommand(text: string): GenshinCommand | null {
  if (text === '原神') return { kind: 'menu' };
  if (text === '原神绑定') return { kind: 'bind' };
  if (/^原神(?:确认|确定)\s*$/.test(text)) return { kind: 'confirm_help' };
  const confirm = text.match(/^原神(?:确认|确定)\s+(\d{6})$/);
  if (confirm?.[1]) return { kind: 'confirm', confirmCode: confirm[1] };
  if (text === '原神签到') return { kind: 'sign' };
  if (/^原神兑换\s*$/.test(text)) return { kind: 'redeem_help' };
  const redeem = text.match(/^原神兑换\s+([A-Za-z0-9]{6,32})$/);
  if (redeem?.[1]) return { kind: 'redeem', cdkey: redeem[1] };
  if (text === '抽卡记录' || text === '原神抽卡记录') return { kind: 'gacha_records' };
  if (text === '原神解绑') return { kind: 'unbind' };
  return null;
}

function canUseGenshinInSession(session: Session, allowedGroups: Set<string>): boolean {
  const carrier = session as Session & { isDirect?: boolean; guildId?: string | null; channelId?: string | null };
  if (carrier.isDirect === true) return true;
  const groupId = normalizeGroupId(carrier.guildId) ?? normalizeGroupId(carrier.channelId);
  return Boolean(groupId && allowedGroups.has(groupId));
}

function canInvokeGenshinInSession(session: Session, naturalTriggerEnabled: boolean, naturalTriggerGroups: Set<string>): boolean {
  const carrier = session as Session & {
    isDirect?: boolean;
    guildId?: string | null;
    channelId?: string | null;
    stripped?: { atSelf?: unknown };
  };
  if (carrier.isDirect === true) return true;
  if (carrier.stripped?.atSelf === true) return true;
  if (!naturalTriggerEnabled) return false;
  const groupId = normalizeGroupId(carrier.guildId) ?? normalizeGroupId(carrier.channelId);
  return Boolean(groupId && naturalTriggerGroups.has(groupId));
}

function resolveOwnerIdentity(session: Session): OwnerIdentity {
  const platform = String(session.platform ?? '').trim();
  const qqUserId = String(session.userId ?? '').trim();
  const channelId = String(session.channelId ?? '').trim();
  if (!platform || !qqUserId || !channelId) {
    throw new GenshinUserError('当前会话缺少 QQ 身份信息，无法绑定原神。');
  }
  return {
    ownerKey: `${platform}:${qqUserId}`,
    platform,
    qqUserId,
    channelId,
  };
}

function writeHtml(koaCtx: any, status: number, html: string): void {
  koaCtx.status = status;
  koaCtx.set('content-type', 'text/html; charset=utf-8');
  koaCtx.body = html;
}

function writeJson(koaCtx: any, status: number, body: Record<string, unknown>): void {
  koaCtx.status = status;
  koaCtx.set('content-type', 'application/json; charset=utf-8');
  koaCtx.body = body;
}

async function readRequestBody(koaCtx: any): Promise<Record<string, unknown>> {
  const body = koaCtx.request?.body;
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  const raw = await readRawBody(koaCtx.req);
  const contentType = String(koaCtx.get?.('content-type') ?? koaCtx.request?.headers?.['content-type'] ?? '');
  if (contentType.includes('application/json')) {
    const parsed = JSON.parse(raw || '{}') as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return {};
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

async function readRawBody(stream: AsyncIterable<Buffer | string> | undefined): Promise<string> {
  if (!stream) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function toUserMessage(error: unknown): string {
  if (error instanceof GenshinUserError) return error.message;
  logger.warn('genshin operation failed: %s', error instanceof Error ? error.message : String(error));
  return '原神功能处理失败，请稍后重试。';
}
