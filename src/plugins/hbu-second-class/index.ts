import { Context, h, Logger, Schema, type Fragment, type Session } from 'koishi';
import type { CampusAuthServiceLike } from '../../types/campus-auth.js';
import type { NativeFeatureChatServiceLike } from '../../types/native-feature-chat.js';
import '../../types/campus-auth.js';
import '../../types/hbu-second-class.js';
import '../../types/native-feature-chat.js';
import {
  CAMPUS_AUTH_PROVIDER_SECOND_CLASS,
  CampusAuthUserError,
} from '../campus-auth-core/index.js';
import { CampusOwnerError, resolveCampusOwnerIdentity } from '../shared/campus-owner.js';
import { normalizeGroupId, parseGroupSet } from '../shared/group-id.js';
import { ensureSecondClassCacheTables, SecondClassCache } from './cache.js';
import { SecondClassHttpClient } from './client.js';
import { HbuSecondClassMenuService, type HbuSecondClassMenuPuppeteerLike } from './menu.js';
import { ensureSecondClassReauthTable, SecondClassReauthStore } from './reauth-store.js';
import { renderSecondClassRadar, renderSecondClassTranscript, type SecondClassPuppeteerLike } from './render.js';
import {
  HbuSecondClassAuthProvider,
  HbuSecondClassService,
  SecondClassReauthRequiredError,
  type SecondClassReauthPrompt,
} from './service.js';
import type { SecondClassCaptcha, SecondClassPage } from './types.js';

export const name = 'hbu-second-class';
export const inject = ['campusAuth', 'database', 'nativeFeatureChat', 'puppeteer'] as const;

const logger = new Logger(name);

export interface Config {
  allowedGroups?: string[] | string;
  naturalTriggerEnabled?: boolean;
  naturalTriggerGroups?: string[] | string;
}

export const Config: Schema<Config> = Schema.object({
  allowedGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('允许使用二课功能的群号列表；私聊始终允许。'),
    Schema.string().description('允许使用二课功能的群号，多个群号用逗号分隔；私聊始终允许。'),
  ]),
  naturalTriggerEnabled: Schema.boolean().default(false).description('是否允许白名单群聊裸触发二课命令。'),
  naturalTriggerGroups: Schema.union([Schema.array(Schema.string()).role('table'), Schema.string()]),
});

interface SecondClassContext {
  campusAuth: CampusAuthServiceLike;
  database: import('../campus-auth-core/index.js').CampusAuthDatabase;
  nativeFeatureChat: NativeFeatureChatServiceLike;
  puppeteer: SecondClassPuppeteerLike & HbuSecondClassMenuPuppeteerLike;
}

interface RuntimeConfig {
  allowedGroups: Set<string>;
  naturalTriggerEnabled: boolean;
  naturalTriggerGroups: Set<string>;
}

export function apply(ctx: Context, config: Config): void {
  const services = ctx as unknown as SecondClassContext;
  const runtime: RuntimeConfig = {
    allowedGroups: requireAllowedGroups(config.allowedGroups, 'hbu-second-class.allowedGroups'),
    naturalTriggerEnabled: config.naturalTriggerEnabled === true,
    naturalTriggerGroups: parseGroupSet(config.naturalTriggerGroups ?? ''),
  };
  ensureSecondClassCacheTables(ctx);
  ensureSecondClassReauthTable(ctx);
  const cache = new SecondClassCache(services.database);
  const reauthStore = new SecondClassReauthStore(services.database);
  const client = new SecondClassHttpClient();
  const service = new HbuSecondClassService(services.campusAuth, client, cache, reauthStore);
  const menuService = new HbuSecondClassMenuService(services.puppeteer);
  const unregisterProvider = services.campusAuth.registerProvider(new HbuSecondClassAuthProvider(client));
  const unregisterLocationActions = services.campusAuth.registerLocationActionProvider(service);
  const unregisterCapability = services.nativeFeatureChat.registerCapability({
    id: 'hbu-second-class',
    isRelevant: shouldExposeSecondClassCapabilityReference,
    buildReference: (session) => buildCapabilityReference(session, runtime),
  });
  const unregisterLifecycle = services.campusAuth.registerLifecycleListener(async (event) => {
    if (event.providerId === CAMPUS_AUTH_PROVIDER_SECOND_CLASS || event.derivedProviderIds.includes(CAMPUS_AUTH_PROVIDER_SECOND_CLASS)) {
      await cache.clearOwner(event.ownerKey);
      await reauthStore.clearOwner(event.ownerKey);
    }
  });
  provideService(ctx, service);
  registerMiddleware(ctx, services, service, menuService, runtime);
  ctx.on?.('dispose', () => {
    unregisterProvider();
    unregisterLocationActions();
    unregisterCapability();
    unregisterLifecycle();
  });
}

function provideService(ctx: Context, service: HbuSecondClassService): void {
  const provider = ctx as Context & { provide?: (name: string) => void; set?: (name: string, value: unknown) => void };
  if (typeof provider.provide === 'function' && typeof provider.set === 'function') {
    provider.provide('hbuSecondClass');
    provider.set('hbuSecondClass', service);
  } else {
    provider.hbuSecondClass = service;
  }
}

function registerMiddleware(ctx: Context, services: SecondClassContext, service: HbuSecondClassService, menuService: HbuSecondClassMenuService, runtime: RuntimeConfig): void {
  ctx.middleware(async (session, next) => {
    const text = String((session as Session & { stripped?: { content?: unknown } }).stripped?.content ?? session.content ?? '').trim();
    const command = parseSecondClassCommand(text);
    if (!command) return next();
    if (!canInvoke(session, runtime)) return next();
    if (!canUse(session, runtime.allowedGroups)) {
      await reply(services.nativeFeatureChat, session, command, text, '当前群未开启二课功能。', '当前群未开启二课功能。', false);
      return;
    }
    try {
      const identity = resolveCampusOwnerIdentity(session);
      if (command.kind === 'menu') {
        await reply(services.nativeFeatureChat, session, command, text, await menuService.queryMenu(identity.qqUserId), '机器人返回了二课功能菜单图片。');
      } else if (command.kind === 'bind') {
        const result = await services.campusAuth.startBinding(identity, CAMPUS_AUTH_PROVIDER_SECOND_CLASS);
        await reply(services.nativeFeatureChat, session, command, text, [
          h.at(identity.qqUserId),
          h.text(`\n请打开链接完成二课绑定：\n${result.link}\n链接 10 分钟内有效。\n\n网页验证成功后，请回到这里发送“二课确认 <6位确认码>”。`),
        ], '机器人提供了二课一次性绑定链接。', true, false);
      } else if (command.kind === 'confirm_help') {
        await reply(services.nativeFeatureChat, session, command, text, '请发送：二课确认 <6位确认码>。', '机器人说明了二课确认命令。');
      } else if (command.kind === 'confirm') {
        const result = await services.campusAuth.confirmBinding(identity, CAMPUS_AUTH_PROVIDER_SECOND_CLASS, command.code);
        await reply(services.nativeFeatureChat, session, command, text, `二课绑定完成。绑定方式：${methodLabel(result.method)}。`, '二课绑定完成。', true, false);
      } else if (command.kind === 'status') {
        const status = await service.getBindingStatus(identity);
        const details = status.method ? `${status.status}\n绑定方式：${methodLabel(status.method)}` : status.status;
        await reply(services.nativeFeatureChat, session, command, text, details, '机器人返回了二课绑定状态。', true, false);
      } else if (command.kind === 'unbind') {
        await services.campusAuth.unbind(identity, CAMPUS_AUTH_PROVIDER_SECOND_CLASS);
        await reply(services.nativeFeatureChat, session, command, text, '二课绑定及二课历史缓存已清理；志愿汇绑定保持不变。', '二课绑定已解除。');
      } else if (command.kind === 'reauth_request') {
        const required = await service.beginReauth(identity);
        await replyReauthCaptcha(services.nativeFeatureChat, session, command, text, identity.qqUserId, required);
      } else if (command.kind === 'reauth_submit') {
        await service.completeReauth(identity, command.code);
        await reply(services.nativeFeatureChat, session, command, text, '二课续登成功，请重新发送原查询命令。', '二课验证码验证成功，登录态已续期。', true, false);
      } else if (command.kind === 'credits') {
        const result = await service.queryCredits(identity);
        await reply(services.nativeFeatureChat, session, command, text, `${formatCredits(result.data)}${cacheNotice(result)}`, '机器人返回了二课学分。');
      } else if (command.kind === 'transcript') {
        const result = await service.queryTranscript(identity, command.semester);
        const image = await renderSecondClassTranscript(services.puppeteer, result.data, command.semester);
        await reply(services.nativeFeatureChat, session, command, text, [image, h.text(cacheNotice(result))], '机器人返回了二课成绩单。');
      } else if (command.kind === 'radar') {
        const result = await service.queryRadar(identity);
        const image = await renderSecondClassRadar(services.puppeteer, result.data);
        await reply(services.nativeFeatureChat, session, command, text, [image, h.text(cacheNotice(result))], '机器人返回了二课雷达图。');
      } else if (command.kind === 'activities') {
        const result = await service.queryActivities(identity);
        await reply(services.nativeFeatureChat, session, command, text, `${formatPage('二课活动', result.data)}${cacheNotice(result)}`, '机器人返回了二课活动。');
      } else if (command.kind === 'records') {
        const result = await service.queryRecords(identity);
        await reply(services.nativeFeatureChat, session, command, text, `${formatPage('二课学分记录', result.data)}${cacheNotice(result)}`, '机器人返回了二课学分记录。');
      } else if (command.kind === 'sign_in' || command.kind === 'sign_out') {
        const operation = command.kind === 'sign_in' ? 'sign_in' : 'sign_out';
        const result = await service.signWithCode(identity, operation, command.code);
        const content = result.locationLink
          ? `请打开一次性链接，授权手机定位并确认${operation === 'sign_in' ? '签到' : '签退'}：\n${result.locationLink}\n链接 5 分钟内有效。`
          : result.message ?? '二课操作已完成。';
        await reply(services.nativeFeatureChat, session, command, text, content, `机器人已处理二课${operation === 'sign_in' ? '签到' : '签退'}。`, true, false);
      }
    } catch (error) {
      if (error instanceof SecondClassReauthRequiredError) {
        const identity = resolveCampusOwnerIdentity(session);
        await replyReauthCaptcha(services.nativeFeatureChat, session, command, text, identity.qqUserId, error.prompt);
        return;
      }
      const message = error instanceof CampusAuthUserError || error instanceof CampusOwnerError ? error.message : '二课功能处理失败，请稍后重试。';
      if (!(error instanceof CampusAuthUserError) && !(error instanceof CampusOwnerError)) logger.warn('second-class command failed: %s', error instanceof Error ? error.message : String(error));
      await reply(services.nativeFeatureChat, session, command, text, message, `二课功能未完成：${message}`, false, !['confirm', 'sign_in', 'sign_out'].includes(command.kind));
    }
  });
}

type SecondClassCommand =
  | { kind: 'menu' }
  | { kind: 'bind' }
  | { kind: 'confirm_help' }
  | { kind: 'confirm'; code: string }
  | { kind: 'status' }
  | { kind: 'unbind' }
  | { kind: 'reauth_request' }
  | { kind: 'reauth_submit'; code: string }
  | { kind: 'credits' }
  | { kind: 'transcript'; semester?: string }
  | { kind: 'radar' }
  | { kind: 'activities' }
  | { kind: 'records' }
  | { kind: 'sign_in'; code: string }
  | { kind: 'sign_out'; code: string };

export function parseSecondClassCommand(text: string): SecondClassCommand | null {
  if (text === '二课') return { kind: 'menu' };
  if (text === '二课绑定') return { kind: 'bind' };
  if (/^二课确认\s*$/.test(text)) return { kind: 'confirm_help' };
  const confirm = text.match(/^二课确认\s+(\d{6})$/);
  if (confirm?.[1]) return { kind: 'confirm', code: confirm[1] };
  if (text === '二课状态') return { kind: 'status' };
  if (text === '二课解绑') return { kind: 'unbind' };
  if (/^二课验证\s*$/.test(text)) return { kind: 'reauth_request' };
  const reauth = text.match(/^二课验证\s+([A-Za-z0-9]{1,16})$/);
  if (reauth?.[1]) return { kind: 'reauth_submit', code: reauth[1] };
  if (text === '二课学分') return { kind: 'credits' };
  const transcript = text.match(/^二课成绩单(?:\s+([^\s]+))?$/);
  if (transcript) return { kind: 'transcript', semester: transcript[1] };
  if (text === '二课雷达') return { kind: 'radar' };
  if (text === '二课活动') return { kind: 'activities' };
  if (text === '二课记录') return { kind: 'records' };
  const signIn = text.match(/^二课签到\s+(\d{6})$/);
  if (signIn?.[1]) return { kind: 'sign_in', code: signIn[1] };
  const signOut = text.match(/^二课签退\s+(\d{6})$/);
  if (signOut?.[1]) return { kind: 'sign_out', code: signOut[1] };
  return null;
}

function formatCredits(data: unknown): string {
  const record = asRecord(data);
  const lines = ['二课学分'];
  addMetric(lines, '第一课堂', record.oneScore);
  addMetric(lines, '第二课堂', record.twoScore);
  addMetric(lines, '无效学分', record.invalidScore);
  const categories = Array.isArray(record.creditCategoryDetailsList) ? record.creditCategoryDetailsList : [];
  for (const item of categories.slice(0, 12)) {
    const row = asRecord(item);
    const name = textValue(row.categoryName || row.name);
    if (!name) continue;
    const actual = textValue(row.actualCreditScore || row.creditScore || row.score) || '0';
    const required = textValue(row.requiredCreditScore || row.requiredScore);
    lines.push(`${name}：${actual}${required ? ` / ${required}` : ''}${row.qualified === false ? '（未达标）' : ''}`);
  }
  if (lines.length === 1) lines.push('暂无学分数据。');
  return lines.join('\n');
}

function formatPage(title: string, page: SecondClassPage): string {
  if (!page.rows.length) return `${title}\n暂无记录。`;
  return [title, ...page.rows.map((row, index) => {
    const name = firstText(row, ['activityName', 'projectName', 'name', 'title', 'creditTypeName']) || '未命名记录';
    const meta = [
      firstText(row, ['semesterName', 'yearSemester', 'categoryName', 'statusName']),
      firstText(row, ['creditScore', 'score', 'actualCreditScore']) ? `学分 ${firstText(row, ['creditScore', 'score', 'actualCreditScore'])}` : '',
      firstText(row, ['startTime', 'createTime', 'activityTime']),
    ].filter(Boolean).join('｜');
    return `${index + 1}. ${name}${meta ? `\n   ${meta}` : ''}`;
  })].join('\n');
}

function cacheNotice(result: { source: string; fetchedAt: number }): string {
  if (result.source !== 'database') return '';
  return `\n网络请求失败，以上为 ${new Date(result.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 抓取的历史数据。`;
}

function methodLabel(method: string): string {
  return ({
    managed_credentials: '托管二课账号登录',
    direct_credentials: '二课账号登录',
    token_import: '导入二课 Token',
  } as Record<string, string>)[method] ?? method;
}

function addMetric(lines: string[], label: string, value: unknown): void {
  const text = textValue(value);
  if (text) lines.push(`${label}：${text}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return '';
}

function textValue(value: unknown): string {
  return value == null || typeof value === 'object' ? '' : String(value).trim();
}

function canUse(session: Session, allowedGroups: Set<string>): boolean {
  if (session.isDirect === true) return true;
  const groupId = normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
  return Boolean(groupId && allowedGroups.has(groupId));
}

function canInvoke(session: Session, runtime: RuntimeConfig): boolean {
  if (session.isDirect === true || (session as Session & { stripped?: { atSelf?: unknown } }).stripped?.atSelf === true) return true;
  if (!runtime.naturalTriggerEnabled) return false;
  const groupId = normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
  return Boolean(groupId && runtime.naturalTriggerGroups.has(groupId));
}

function buildCapabilityReference(session: Session, runtime: RuntimeConfig): string {
  if (!shouldExposeSecondClassCapabilityReference(session)) return '';
  const enabled = canUse(session, runtime.allowedGroups);
  return [
    `河北大学二课功能（当前会话${enabled ? '可用' : '未启用'}）：`,
    '- 总入口：“二课”。',
    '- 账号：“二课绑定”、“二课确认 <6位确认码>”、“二课状态”、“二课解绑”。',
    '- 续登：“二课验证”获取验证码图片，“二课验证 <验证码>”提交。',
    '- 查询：“二课学分”、“二课成绩单 [学期]”、“二课雷达”、“二课活动”、“二课记录”。',
    '- 签到：“二课签到 <6位签到码>”、“二课签退 <6位签到码>”；私聊和控制台已启用的群聊均可使用，定位活动会返回一次性确认链接。',
  ].join('\n');
}

const SECOND_CLASS_USAGE_INTENT_PATTERN = /(?:(?:怎么|如何|怎样|咋).{0,4}(?:查|看|用)|查询|查看|使用|发送|输入|命令|格式|入口|菜单|功能|失败|报错)/;

export function shouldExposeSecondClassCapabilityReference(session: Session): boolean {
  const text = String((session as Session & { stripped?: { content?: unknown } }).stripped?.content ?? session.content ?? '').trim();
  if (!text) return false;
  if (parseSecondClassCommand(text)) return true;
  if (/^二课(?:确认\d{6}|验证\S+|成绩单\S+)/.test(text)) return true;
  return text.includes('二课') && SECOND_CLASS_USAGE_INTENT_PATTERN.test(text);
}

async function reply(
  nativeFeatureChat: NativeFeatureChatServiceLike,
  session: Session,
  command: SecondClassCommand,
  text: string,
  content: Fragment,
  summary: string,
  success = true,
  includeReplyPayload = true,
): Promise<void> {
  await nativeFeatureChat.sendReply(session, {
    featureId: 'hbu-second-class',
    commandId: command.kind,
    userText: command.kind === 'confirm'
      ? '二课确认 <确认码已隐藏>'
      : command.kind === 'reauth_submit'
        ? '二课验证 <验证码已隐藏>'
        : command.kind === 'sign_in'
          ? '二课签到 <签到码已隐藏>'
          : command.kind === 'sign_out' ? '二课签退 <签到码已隐藏>' : text,
    reply: content,
    summary,
    success,
    includeReplyPayload,
  });
}

async function replyReauthCaptcha(
  nativeFeatureChat: NativeFeatureChatServiceLike,
  session: Session,
  command: SecondClassCommand,
  text: string,
  qqUserId: string,
  prompt: SecondClassReauthPrompt,
): Promise<void> {
  await reply(
    nativeFeatureChat,
    session,
    command,
    text,
    buildSecondClassReauthReply(qqUserId, prompt),
    '机器人发送了二课续登验证码图片。',
    false,
    false,
  );
}

export function buildSecondClassReauthReply(qqUserId: string, prompt: SecondClassReauthPrompt, now = Date.now()): Fragment {
  const minutes = Math.max(1, Math.ceil((prompt.expiresAt - now) / 60_000));
  return [
    h.at(qqUserId),
    h.text(`\n${prompt.message}\n`),
    secondClassCaptchaImage(prompt.captcha),
    h.text(`\n请在 ${minutes} 分钟内回复：二课验证 <验证码>`),
  ];
}

export function secondClassCaptchaImage(captcha: SecondClassCaptcha): ReturnType<typeof h.image> {
  const matched = captcha.imageDataUrl.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!matched?.[1] || !matched[2]) throw new Error('second-class captcha is not a valid base64 image data URL.');
  return h.image(Buffer.from(matched[2], 'base64'), matched[1]);
}

function requireAllowedGroups(value: string[] | string | undefined, key: string): Set<string> {
  if (value == null) throw new Error(`${key} 必须显式配置。`);
  return parseGroupSet(value);
}
