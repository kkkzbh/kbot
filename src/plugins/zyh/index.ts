import { Context, h, Logger, Schema, type Fragment, type Session } from 'koishi';
import type { CampusAuthServiceLike } from '../../types/campus-auth.js';
import type { NativeFeatureChatServiceLike } from '../../types/native-feature-chat.js';
import '../../types/campus-auth.js';
import '../../types/native-feature-chat.js';
import '../../types/zyh.js';
import { CAMPUS_AUTH_PROVIDER_ZYH, CampusAuthUserError } from '../campus-auth-core/index.js';
import { CampusOwnerError, resolveCampusOwnerIdentity } from '../shared/campus-owner.js';
import { normalizeGroupId, parseGroupSet } from '../shared/group-id.js';
import { ZyhHttpClient } from './client.js';
import { ensureZyhCacheTables, ZyhCache } from './cache.js';
import { ZyhAuthProvider, ZyhService } from './service.js';
import type { ZyhActivity } from './types.js';

export const name = 'zyh';
export const inject = ['campusAuth', 'database', 'nativeFeatureChat'] as const;

const logger = new Logger(name);

export interface Config {
  allowedGroups?: string[] | string;
  naturalTriggerEnabled?: boolean;
  naturalTriggerGroups?: string[] | string;
}

export const Config: Schema<Config> = Schema.object({
  allowedGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('允许使用志愿汇功能的群号列表；私聊始终允许。'),
    Schema.string().description('允许使用志愿汇功能的群号，多个群号用逗号分隔；私聊始终允许。'),
  ]),
  naturalTriggerEnabled: Schema.boolean().default(false).description('是否允许白名单群聊裸触发志愿汇命令。'),
  naturalTriggerGroups: Schema.union([
    Schema.array(Schema.string()).role('table'),
    Schema.string(),
  ]),
});

interface ZyhContext {
  campusAuth: CampusAuthServiceLike;
  database: import('../campus-auth-core/index.js').CampusAuthDatabase;
  nativeFeatureChat: NativeFeatureChatServiceLike;
}

interface RuntimeConfig {
  allowedGroups: Set<string>;
  naturalTriggerEnabled: boolean;
  naturalTriggerGroups: Set<string>;
}

export function apply(ctx: Context, config: Config): void {
  const serviceCtx = ctx as unknown as ZyhContext;
  const runtime: RuntimeConfig = {
    allowedGroups: requireAllowedGroups(config.allowedGroups, 'zyh.allowedGroups'),
    naturalTriggerEnabled: config.naturalTriggerEnabled === true,
    naturalTriggerGroups: parseGroupSet(config.naturalTriggerGroups ?? ''),
  };
  const client = new ZyhHttpClient();
  ensureZyhCacheTables(ctx);
  const cache = new ZyhCache(serviceCtx.database);
  const service = new ZyhService(serviceCtx.campusAuth, client, cache);
  const unregisterProvider = serviceCtx.campusAuth.registerProvider(new ZyhAuthProvider(client));
  const unregisterCapability = serviceCtx.nativeFeatureChat.registerCapability({
    id: 'zyh',
    isRelevant: shouldExposeZyhCapabilityReference,
    buildReference: (session) => buildZyhCapabilityReference(session, runtime),
  });
  const unregisterLifecycle = serviceCtx.campusAuth.registerLifecycleListener(async (event) => {
    if (event.providerId === CAMPUS_AUTH_PROVIDER_ZYH) await cache.clearOwner(event.ownerKey);
  });
  provideZyhService(ctx, service);
  registerMiddleware(ctx, serviceCtx, service, runtime);
  ctx.on?.('dispose', () => {
    unregisterProvider();
    unregisterCapability();
    unregisterLifecycle();
  });
}

function provideZyhService(ctx: Context, service: ZyhService): void {
  const provider = ctx as Context & { provide?: (name: string) => void; set?: (name: string, value: unknown) => void };
  if (typeof provider.provide === 'function' && typeof provider.set === 'function') {
    provider.provide('zyh');
    provider.set('zyh', service);
  } else {
    provider.zyh = service;
  }
}

function registerMiddleware(ctx: Context, services: ZyhContext, service: ZyhService, runtime: RuntimeConfig): void {
  ctx.middleware(async (session, next) => {
    const text = String((session as Session & { stripped?: { content?: unknown } }).stripped?.content ?? session.content ?? '').trim();
    const command = parseZyhCommand(text);
    if (!command) return next();
    if (!canInvoke(session, runtime)) return next();
    if (!canUse(session, runtime.allowedGroups)) {
      await reply(services.nativeFeatureChat, session, command, text, '当前群未开启志愿汇功能。', '当前群未开启志愿汇功能。', false);
      return;
    }
    try {
      const identity = resolveCampusOwnerIdentity(session);
      if (command.kind === 'menu') {
        await reply(services.nativeFeatureChat, session, command, text, zyhMenu(), '机器人返回了志愿汇功能菜单。');
      } else if (command.kind === 'bind') {
        const result = await services.campusAuth.startBinding(identity, CAMPUS_AUTH_PROVIDER_ZYH);
        await reply(services.nativeFeatureChat, session, command, text, [
          h.at(identity.qqUserId),
          h.text(`\n请打开链接完成志愿汇绑定：\n${result.link}\n链接 10 分钟内有效。\n\n网页验证成功后，请回到这里发送“志愿汇确认 <6位确认码>”。`),
        ], '机器人提供了志愿汇一次性绑定链接。', true, false);
      } else if (command.kind === 'confirm_help') {
        await reply(services.nativeFeatureChat, session, command, text, '请发送：志愿汇确认 <6位确认码>。', '机器人说明了志愿汇确认命令。');
      } else if (command.kind === 'confirm') {
        const result = await services.campusAuth.confirmBinding(identity, CAMPUS_AUTH_PROVIDER_ZYH, command.code);
        await reply(services.nativeFeatureChat, session, command, text, `志愿汇绑定完成。绑定方式：${methodLabel(result.method)}。`, '志愿汇绑定完成。', true, false);
      } else if (command.kind === 'status') {
        const status = await services.campusAuth.getStatus(identity.ownerKey, CAMPUS_AUTH_PROVIDER_ZYH);
        const details = status.method ? `${status.status}\n绑定方式：${methodLabel(status.method)}` : status.status;
        await reply(services.nativeFeatureChat, session, command, text, details, '机器人返回了志愿汇绑定状态。', true, false);
      } else if (command.kind === 'unbind') {
        await services.campusAuth.unbind(identity, CAMPUS_AUTH_PROVIDER_ZYH);
        await reply(services.nativeFeatureChat, session, command, text, '志愿汇绑定已解除；由该账号生成的二课 SSO 登录态也已撤销。', '志愿汇绑定已解除。');
      } else if (command.kind === 'hours') {
        const result = await service.queryHours(identity);
        const profile = result.data;
        const name = profile.info.nickname || profile.info.real_name || '志愿者';
        await reply(services.nativeFeatureChat, session, command, text, [
          `${name}的志愿时长`,
          `信用时数：${formatNumber(profile.hoursSystem)} 小时`,
          `荣誉时数：${formatNumber(profile.hoursHistory)} 小时`,
          `合计：${formatNumber(profile.hoursTotal)} 小时`,
          `公益益币：${formatNumber(profile.points)}`,
          cacheNotice(result),
        ].filter(Boolean).join('\n'), '机器人返回了志愿时长。');
      } else if (command.kind === 'activities') {
        const result = await service.queryActivities(identity, 1, command.keyword);
        await reply(services.nativeFeatureChat, session, command, text, `${formatActivities('志愿活动', result.data)}${cacheNotice(result, '\n')}`, '机器人返回了志愿活动列表。');
      } else if (command.kind === 'my_activities') {
        const result = await service.queryMyActivities(identity, command.page);
        await reply(services.nativeFeatureChat, session, command, text, `${formatActivities(`我的志愿活动（第 ${command.page} 页）`, result.data)}${cacheNotice(result, '\n')}`, '机器人返回了我的志愿活动。');
      } else if (command.kind === 'records') {
        const result = await service.queryRecords(identity, command.page);
        await reply(services.nativeFeatureChat, session, command, text, `${formatActivities(`志愿记录（第 ${command.page} 页）`, result.data)}${cacheNotice(result, '\n')}`, '机器人返回了已完成志愿活动记录。');
      }
    } catch (error) {
      const message = error instanceof CampusAuthUserError || error instanceof CampusOwnerError ? error.message : '志愿汇功能处理失败，请稍后重试。';
      if (!(error instanceof CampusAuthUserError) && !(error instanceof CampusOwnerError)) logger.warn('zyh command failed: %s', error instanceof Error ? error.message : String(error));
      await reply(services.nativeFeatureChat, session, command, text, message, `志愿汇功能未完成：${message}`, false, command.kind !== 'confirm');
    }
  });
}

function cacheNotice(result: { source: string; fetchedAt: number }, prefix = ''): string {
  if (result.source !== 'database') return '';
  return `${prefix}网络请求失败，以上为 ${new Date(result.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 抓取的历史数据。`;
}

type ZyhCommand =
  | { kind: 'menu' }
  | { kind: 'bind' }
  | { kind: 'confirm_help' }
  | { kind: 'confirm'; code: string }
  | { kind: 'status' }
  | { kind: 'unbind' }
  | { kind: 'hours' }
  | { kind: 'records'; page: number }
  | { kind: 'activities'; keyword?: string }
  | { kind: 'my_activities'; page: number };

export function parseZyhCommand(text: string): ZyhCommand | null {
  if (text === '志愿汇') return { kind: 'menu' };
  if (text === '志愿汇绑定') return { kind: 'bind' };
  if (/^志愿汇确认\s*$/.test(text)) return { kind: 'confirm_help' };
  const confirm = text.match(/^志愿汇确认\s+(\d{6})$/);
  if (confirm?.[1]) return { kind: 'confirm', code: confirm[1] };
  if (text === '志愿汇状态') return { kind: 'status' };
  if (text === '志愿汇解绑') return { kind: 'unbind' };
  if (text === '志愿时长') return { kind: 'hours' };
  const records = text.match(/^志愿记录(?:\s+(\d+))?$/);
  if (records) return { kind: 'records', page: positivePage(records[1]) };
  const myActivities = text.match(/^我的志愿活动(?:\s+(\d+))?$/);
  if (myActivities) return { kind: 'my_activities', page: positivePage(myActivities[1]) };
  const activities = text.match(/^志愿活动(?:\s+(.+))?$/);
  if (activities) return { kind: 'activities', keyword: activities[1]?.trim() || undefined };
  return null;
}

function zyhMenu(): string {
  return [
    '志愿汇功能',
    '账号：志愿汇绑定｜志愿汇状态｜志愿汇解绑',
    '查询：志愿时长｜志愿记录 [页码]｜志愿活动 [关键词]｜我的志愿活动 [页码]',
  ].join('\n');
}

function formatActivities(title: string, rows: ZyhActivity[]): string {
  if (!rows.length) return `${title}\n暂无记录。`;
  return [title, ...rows.map((row, index) => {
    const time = row.recruitFinishTime ? new Date(row.recruitFinishTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
    const meta = [row.departmentName, row.city || row.county, time, row.isFinished ? '已结束' : row.statusText].filter(Boolean).join('｜');
    return `${index + 1}. ${row.title}${meta ? `\n   ${meta}` : ''}`;
  })].join('\n');
}

function methodLabel(method: string): string {
  return ({
    managed_credentials: '托管账号登录（支持自动续期）',
    session_credentials: '单次账号登录',
    session_import: '导入现有会话',
  } as Record<string, string>)[method] ?? method;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.0+$/, '');
}

function positivePage(value?: string): number {
  const parsed = Number(value ?? '1');
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 1;
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

function buildZyhCapabilityReference(session: Session, runtime: RuntimeConfig): string {
  if (!shouldExposeZyhCapabilityReference(session)) return '';
  const enabled = canUse(session, runtime.allowedGroups);
  return [
    `志愿汇功能（当前会话${enabled ? '可用' : '未启用'}）：`,
    '- 总入口：“志愿汇”。',
    '- 账号：“志愿汇绑定”、“志愿汇确认 <6位确认码>”、“志愿汇状态”、“志愿汇解绑”。',
    '- 查询：“志愿时长”、“志愿记录 [页码]”、“志愿活动 [关键词]”、“我的志愿活动 [页码]”。',
  ].join('\n');
}

const ZYH_USAGE_TOPIC_PATTERN = /(?:志愿汇|志愿时长|志愿记录|志愿活动|我的志愿活动)/;
const ZYH_USAGE_INTENT_PATTERN = /(?:(?:怎么|如何|怎样|咋).{0,4}(?:查|看|用)|查询|查看|使用|发送|输入|命令|格式|入口|菜单|功能|失败|报错)/;

export function shouldExposeZyhCapabilityReference(session: Session): boolean {
  const text = String((session as Session & { stripped?: { content?: unknown } }).stripped?.content ?? session.content ?? '').trim();
  if (!text) return false;
  if (parseZyhCommand(text)) return true;
  if (/^志愿汇确认\d{6}$/.test(text)) return true;
  return ZYH_USAGE_TOPIC_PATTERN.test(text) && ZYH_USAGE_INTENT_PATTERN.test(text);
}

async function reply(
  nativeFeatureChat: NativeFeatureChatServiceLike,
  session: Session,
  command: ZyhCommand,
  text: string,
  content: Fragment,
  summary: string,
  success = true,
  includeReplyPayload = true,
): Promise<void> {
  await nativeFeatureChat.sendReply(session, {
    featureId: 'zyh',
    commandId: command.kind,
    userText: command.kind === 'confirm' ? '志愿汇确认 <确认码已隐藏>' : text,
    reply: content,
    summary,
    success,
    includeReplyPayload,
  });
}

function requireAllowedGroups(value: string[] | string | undefined, key: string): Set<string> {
  if (value == null) throw new Error(`${key} 必须显式配置。`);
  return parseGroupSet(value);
}

export { ZyhService } from './service.js';
