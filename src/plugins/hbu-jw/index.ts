import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { Context, h, Logger, Schema, type Fragment, type Session } from 'koishi';
import type { NativeFeatureChatServiceLike } from '../../types/native-feature-chat.js';
import '../../types/native-feature-chat.js';
import { normalizeGroupId, parseGroupSet } from '../shared/group-id.js';
import { HbuJwAcademicCache } from './academic-cache.js';
import { HbuJwCourseQueryService } from './course-query.js';
import { loadOrCreateKek, resolveKekPath } from './crypto.js';
import { HbuJwExamScheduleService } from './exams.js';
import { HbuJwGpaService } from './gpa.js';
import { HbuJwHttpClient } from './jw-client.js';
import { HbuJwMenuService } from './menu.js';
import { HbuJwScheduleService, type HbuJwScheduleMode, type HbuJwSchedulePuppeteerLike } from './schedule.js';
import { HbuJwSelectionResultService } from './selection-results.js';
import { HbuJwBindSubmissionPendingError, HbuJwService } from './service.js';
import { ensureHbuJwTables, HbuJwStore } from './store.js';
import { HbuJwTermScoresService, type HbuJwTermScoresMode } from './term-scores.js';
import { HbuJwUserError, type DatabaseLike, type OwnerIdentity } from './types.js';
import { renderBindPage } from './web/bind-page.js';

export const name = 'hbu-jw';
export const inject = ['server', 'database', 'puppeteer', 'nativeFeatureChat'] as const;

const logger = new Logger(name);
const CAMPUS_BACKGROUND_FILE = join(__dirname, 'assets/campus-bg.jpg');
const DEFAULT_BIND_PAGE_PATH = '/jw/bind';
const DEFAULT_BIND_TOKEN_TTL_MS = 600_000;
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 180_000;
const DEFAULT_KEEP_ALIVE_RECENT_USE_WINDOW_MS = 86_400_000;

export interface Config {
  bindPagePath?: string;
  publicBaseUrl?: string;
  bindTokenTtlMs?: number;
  credentialKekPath?: string;
  autoReloginEnabled?: boolean;
  keepAliveEnabled?: boolean;
  keepAliveIntervalMs?: number;
  keepAliveRecentUseWindowMs?: number;
  allowedGroups?: string[] | string;
  naturalTriggerEnabled?: boolean;
  naturalTriggerGroups?: string[] | string;
}

export const Config: Schema<Config> = Schema.object({
  bindPagePath: Schema.string().default(DEFAULT_BIND_PAGE_PATH).description('教务绑定页路径。必须以 / 开头。'),
  publicBaseUrl: Schema.string().description('群聊回复中使用的外部可访问基础 URL。'),
  bindTokenTtlMs: Schema.natural().role('time').default(DEFAULT_BIND_TOKEN_TTL_MS).description('绑定链接有效期。'),
  credentialKekPath: Schema.string().description('教务凭据 KEK 文件路径。文件必须为 0600 权限。'),
  autoReloginEnabled: Schema.boolean().default(true).description('教务 session 失效后是否自动重新登录。'),
  keepAliveEnabled: Schema.boolean().default(false).description('是否启用教务 session 轻量保活。'),
  keepAliveIntervalMs: Schema.natural().role('time').default(DEFAULT_KEEP_ALIVE_INTERVAL_MS).description('保活周期。'),
  keepAliveRecentUseWindowMs: Schema.natural().role('time').default(DEFAULT_KEEP_ALIVE_RECENT_USE_WINDOW_MS).description('只保活最近使用过的登录态。'),
  allowedGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('允许使用教务系统功能的群号列表。只限制群聊，私聊仍允许使用。'),
    Schema.string().description('允许使用教务系统功能的群号，多个群号用英文逗号分隔。只限制群聊，私聊仍允许使用。'),
  ]),
  naturalTriggerEnabled: Schema.boolean().default(false).description('是否允许自然触发白名单群聊裸触发教务命令。'),
  naturalTriggerGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('允许群聊裸触发教务命令的自然触发白名单群号列表。'),
    Schema.string().description('允许群聊裸触发教务命令的自然触发白名单群号，多个群号用英文逗号分隔。'),
  ]),
});

interface HbuJwServicesLike {
  database: DatabaseLike;
  nativeFeatureChat: NativeFeatureChatServiceLike;
  puppeteer: HbuJwSchedulePuppeteerLike;
  server: {
    get(path: string, handler: (koaCtx: any) => unknown): void;
    post(path: string, handler: (koaCtx: any) => unknown): void;
  };
}

interface RuntimeConfig {
  bindPagePath: string;
  publicBaseUrl: string;
  bindTokenTtlMs: number;
  credentialKekPath: string;
  autoReloginEnabled: boolean;
  keepAliveEnabled: boolean;
  keepAliveIntervalMs: number;
  keepAliveRecentUseWindowMs: number;
  allowedGroups: Set<string>;
  naturalTriggerEnabled: boolean;
  naturalTriggerGroups: Set<string>;
  bindSubmitPath: string;
  campusBackgroundPath: string;
}

export function apply(ctx: Context, config: Config): void {
  const runtime = resolveRuntimeConfig(ctx, config);
  const hbuCtx = ctx as unknown as HbuJwServicesLike;
  ensureHbuJwTables(ctx);

  const campusBackgroundStat = statSync(CAMPUS_BACKGROUND_FILE);
  if (!campusBackgroundStat.isFile()) {
    throw new Error(`教务绑定页背景图不存在：${CAMPUS_BACKGROUND_FILE}`);
  }

  const kek = loadOrCreateKek(runtime.credentialKekPath);
  const store = new HbuJwStore(hbuCtx.database);
  const jwClient = new HbuJwHttpClient();
  const academicCache = new HbuJwAcademicCache(store, jwClient);
  const service = new HbuJwService(store, jwClient, kek, {
    bindPagePath: runtime.bindPagePath,
    publicBaseUrl: runtime.publicBaseUrl,
    bindTokenTtlMs: runtime.bindTokenTtlMs,
    autoReloginEnabled: runtime.autoReloginEnabled,
  });
  const gpaService = new HbuJwGpaService(service, jwClient, hbuCtx.puppeteer, academicCache);
  const scheduleService = new HbuJwScheduleService(service, jwClient, hbuCtx.puppeteer, undefined, academicCache);
  const selectionResultService = new HbuJwSelectionResultService(service, jwClient, hbuCtx.puppeteer, academicCache);
  const termScoresService = new HbuJwTermScoresService(service, jwClient, hbuCtx.puppeteer, academicCache);
  const courseQueryService = new HbuJwCourseQueryService(service, jwClient, hbuCtx.puppeteer, academicCache);
  const examScheduleService = new HbuJwExamScheduleService(service, jwClient, hbuCtx.puppeteer, undefined, academicCache);
  const menuService = new HbuJwMenuService(hbuCtx.puppeteer);

  const unregisterCapability = hbuCtx.nativeFeatureChat.registerCapability({
    id: 'hbu-jw',
    buildReference: (session) => buildHbuJwCapabilityReference(session, runtime),
  });
  ctx.on?.('dispose', unregisterCapability);

  registerWebRoutes(hbuCtx, service, runtime);
  registerKeywordMiddleware(
    ctx,
    service,
    gpaService,
    scheduleService,
    selectionResultService,
    termScoresService,
    courseQueryService,
    examScheduleService,
    menuService,
    hbuCtx.nativeFeatureChat,
    runtime,
  );
  registerKeepAlive(ctx, service, runtime);

  ctx.on?.('ready', async () => {
    await store.cleanupExpiredChallenges(Date.now());
  });

  logger.info('HBU JW bind page registered at %s.', runtime.bindPagePath);
}

function resolveRuntimeConfig(ctx: Context, config: Config): RuntimeConfig {
  const bindPagePath = requireAbsolutePath(config.bindPagePath ?? DEFAULT_BIND_PAGE_PATH, 'hbu-jw.bindPagePath');
  const publicBaseUrl = normalizeBaseUrl(config.publicBaseUrl ?? `http://127.0.0.1:${process.env.KOISHI_PORT || '5140'}`, 'hbu-jw.publicBaseUrl');
  const credentialKekPath = resolveKekPath(String((ctx as { baseDir?: string }).baseDir ?? process.cwd()), config.credentialKekPath ?? './.runtime/hbu-jw/credential-kek.key');
  return {
    bindPagePath,
    publicBaseUrl,
    bindTokenTtlMs: requirePositiveInteger(config.bindTokenTtlMs ?? DEFAULT_BIND_TOKEN_TTL_MS, 'hbu-jw.bindTokenTtlMs'),
    credentialKekPath,
    autoReloginEnabled: config.autoReloginEnabled ?? true,
    keepAliveEnabled: config.keepAliveEnabled ?? false,
    keepAliveIntervalMs: requirePositiveInteger(config.keepAliveIntervalMs ?? DEFAULT_KEEP_ALIVE_INTERVAL_MS, 'hbu-jw.keepAliveIntervalMs'),
    keepAliveRecentUseWindowMs: requirePositiveInteger(config.keepAliveRecentUseWindowMs ?? DEFAULT_KEEP_ALIVE_RECENT_USE_WINDOW_MS, 'hbu-jw.keepAliveRecentUseWindowMs'),
    allowedGroups: requireAllowedGroups(config.allowedGroups, 'hbu-jw.allowedGroups'),
    naturalTriggerEnabled: config.naturalTriggerEnabled === true,
    naturalTriggerGroups: parseGroupSet(config.naturalTriggerGroups ?? ''),
    bindSubmitPath: `${bindPagePath}/submit`,
    campusBackgroundPath: `${bindPagePath}/assets/campus-bg.jpg`,
  };
}

function registerWebRoutes(ctx: HbuJwServicesLike, service: HbuJwService, runtime: RuntimeConfig): void {
  ctx.server.get(runtime.bindPagePath, async (koaCtx: any) => {
    const token = String(koaCtx.query?.token ?? koaCtx.request?.query?.token ?? '').trim();
    try {
      const challenge = await service.resolveBindPageChallenge(token);
      writeHtml(koaCtx, 200, renderBindPage({
        backgroundImagePath: runtime.campusBackgroundPath,
        qq: challenge.qqUserId,
        token: challenge.token,
        submitPath: runtime.bindSubmitPath,
        state: challenge.state,
        confirmCode: challenge.confirmCode,
      }));
    } catch (error) {
      writeHtml(koaCtx, 400, renderBindPage({
        backgroundImagePath: runtime.campusBackgroundPath,
        qq: '',
        state: 'invalid',
        message: toUserMessage(error),
      }));
    }
  });

  ctx.server.post(runtime.bindSubmitPath, async (koaCtx: any) => {
    const body = await readRequestBody(koaCtx);
    const token = String(body.token ?? '').trim();
    const username = String(body.username ?? '');
    const persistCredentialConsent = body.persistCredentialConsent === 'yes' || body.persistCredentialConsent === true;
    let qq = '';
    try {
      const challenge = await service.resolveBindPageChallenge(token);
      qq = challenge.qqUserId;
      if (challenge.state !== 'form') {
        writeRedirect(koaCtx, bindPageLocation(runtime, token));
        return;
      }
      await service.submitCredentials({
        token,
        username,
        password: String(body.password ?? ''),
        persistCredentialConsent,
      });
      writeRedirect(koaCtx, bindPageLocation(runtime, token));
    } catch (error) {
      if (error instanceof HbuJwBindSubmissionPendingError) {
        writeRedirect(koaCtx, bindPageLocation(runtime, token));
        return;
      }
      writeHtml(koaCtx, 400, renderBindPage({
        backgroundImagePath: runtime.campusBackgroundPath,
        qq,
        token,
        submitPath: runtime.bindSubmitPath,
        username,
        persistCredentialConsent,
        state: qq ? 'error' : 'invalid',
        message: toUserMessage(error),
      }));
    }
  });

  ctx.server.get(runtime.campusBackgroundPath, (koaCtx: any) => {
    koaCtx.status = 200;
    koaCtx.set('content-type', 'image/jpeg');
    koaCtx.set('cache-control', 'public, max-age=86400');
    koaCtx.body = createReadStream(CAMPUS_BACKGROUND_FILE);
  });
}

function registerKeywordMiddleware(
  ctx: Context,
  service: HbuJwService,
  gpaService: HbuJwGpaService,
  scheduleService: HbuJwScheduleService,
  selectionResultService: HbuJwSelectionResultService,
  termScoresService: HbuJwTermScoresService,
  courseQueryService: HbuJwCourseQueryService,
  examScheduleService: HbuJwExamScheduleService,
  menuService: HbuJwMenuService,
  nativeFeatureChat: NativeFeatureChatServiceLike,
  runtime: RuntimeConfig,
): void {
  ctx.middleware(async (session, next) => {
    const text = normalizeCommandText(session);
    const command = parseHbuJwCommand(text);
    if (!command) return next();

    if (!canInvokeHbuJwInSession(session, runtime.naturalTriggerEnabled, runtime.naturalTriggerGroups)) {
      return next();
    }

    if (!canUseHbuJwInSession(session, runtime.allowedGroups)) {
      await sendHbuJwReply(nativeFeatureChat, session, command, text, '当前群未开启教务系统功能。', {
        summary: '机器人说明当前群未开启教务系统功能。',
        success: false,
      });
      return;
    }

    if (command.kind === 'menu') {
      try {
        const identity = resolveOwnerIdentity(session);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, await menuService.queryMenu(identity.qqUserId), {
          summary: '机器人返回了教务功能菜单图片。',
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'bind') {
      try {
        const identity = resolveOwnerIdentity(session);
        const result = await service.startBinding(identity);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, createMentionedReply(identity.qqUserId, `请打开链接完成教务绑定：\n${result.link}\n链接 10 分钟内有效。\n\n网页登录成功后，页面会显示 6 位确认码。请回到这里发送：\n教务确认 <确认码>\n完成绑定。`), {
          summary: '机器人提供了教务绑定流程；一次性绑定链接未写入历史。',
          includeReplyPayload: false,
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'confirm_help') {
      await sendHbuJwReply(nativeFeatureChat, session, command, text, '请发送完整确认命令：教务确认 <6位确认码>。确认码会在网页登录成功后的页面上显示。', {
        summary: '机器人说明教务确认码必须是 6 位数字。',
      });
      return;
    }

    if (command.kind === 'confirm') {
      try {
        const identity = resolveOwnerIdentity(session);
        await service.confirmBinding(identity, command.confirmCode);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, createMentionedReply(identity.qqUserId, '教务绑定完成。', 'space'), {
          summary: '教务绑定完成。',
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'status') {
      try {
        const identity = resolveOwnerIdentity(session);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, await service.getStatus(identity), {
          summary: '机器人返回了教务绑定状态；详细账号信息未写入历史。',
          includeReplyPayload: false,
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'unbind') {
      try {
        const identity = resolveOwnerIdentity(session);
        await service.unbind(identity);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, '教务绑定已解除。', {
          summary: '教务绑定已解除。',
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'gpa') {
      try {
        const identity = resolveOwnerIdentity(session);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, await gpaService.queryGpa(identity), {
          summary: '机器人返回了 GPA 查询结果。',
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'schedule') {
      try {
        const identity = resolveOwnerIdentity(session);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, await scheduleService.querySchedule(identity, command.mode), {
          summary: command.mode === 'current-week'
            ? '机器人返回了本周课表查询结果图片。'
            : '机器人返回了本学期完整动态课表。',
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'selection_result') {
      try {
        const identity = resolveOwnerIdentity(session);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, await selectionResultService.querySelectionResult(identity), {
          summary: '机器人返回了本学期选课结果图片。',
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'term_scores') {
      try {
        const identity = resolveOwnerIdentity(session);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, await termScoresService.queryTermScores(identity, command.mode), {
          summary: command.mode === 'full'
            ? '机器人返回了本学期成绩查询结果图片。'
            : '机器人返回了本学期匿名成绩查询结果图片。',
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'course_query_help') {
      try {
        const identity = resolveOwnerIdentity(session);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, await courseQueryService.queryHelp(identity.qqUserId), {
          summary: '机器人返回了课程查询命令格式、课程匹配和学期参数说明图片。',
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'course_query') {
      try {
        const identity = resolveOwnerIdentity(session);
        const reply = await courseQueryService.queryCourse(identity, {
          courseQuery: command.courseQuery,
          termInput: command.termInput,
        });
        await sendHbuJwReply(nativeFeatureChat, session, command, text, reply, {
          summary: `机器人返回了“${command.courseQuery}”的课程分项成绩查询结果图片（学期参数：${command.termInput ?? '0'}）。`,
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
      return;
    }

    if (command.kind === 'exam_schedule') {
      try {
        const identity = resolveOwnerIdentity(session);
        await sendHbuJwReply(nativeFeatureChat, session, command, text, await examScheduleService.queryExamSchedule(identity), {
          summary: '机器人返回了本学期考试安排查询结果图片。',
        });
      } catch (error) {
        await sendHbuJwError(nativeFeatureChat, session, command, text, error);
      }
    }
  });
}

function registerKeepAlive(ctx: Context, service: HbuJwService, runtime: RuntimeConfig): void {
  if (!runtime.keepAliveEnabled) return;
  const timer = setInterval(() => {
    service.runKeepAlive(runtime.keepAliveRecentUseWindowMs).catch((error) => {
      logger.warn('hbu jw keep-alive failed: %s', error instanceof Error ? error.message : String(error));
    });
  }, runtime.keepAliveIntervalMs);
  timer.unref?.();
  ctx.on?.('dispose', () => clearInterval(timer));
}

function createMentionedReply(qqUserId: string, content: string, separator: 'newline' | 'space' = 'newline'): Fragment {
  return [h.at(qqUserId), h.text(`${separator === 'newline' ? '\n' : ' '}${content}`)];
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

function normalizeCommandText(session: Session): string {
  const carrier = session as Session & { stripped?: { content?: unknown }; content?: unknown };
  return String(carrier.stripped?.content ?? carrier.content ?? '').trim();
}

type HbuJwCommand =
  | { kind: 'menu' }
  | { kind: 'bind' }
  | { kind: 'confirm_help' }
  | { kind: 'confirm'; confirmCode: string }
  | { kind: 'status' }
  | { kind: 'unbind' }
  | { kind: 'gpa' }
  | { kind: 'schedule'; mode: HbuJwScheduleMode }
  | { kind: 'selection_result' }
  | { kind: 'term_scores'; mode: HbuJwTermScoresMode }
  | { kind: 'course_query_help' }
  | { kind: 'course_query'; courseQuery: string; termInput?: string }
  | { kind: 'exam_schedule' };

interface HbuJwHistoryReplyOptions {
  summary: string;
  success?: boolean;
  includeReplyPayload?: boolean;
}

function hbuJwHistoryUserText(command: HbuJwCommand, text: string): string {
  if (command.kind === 'confirm') return '教务确认 <确认码已隐藏>';
  return text;
}

async function sendHbuJwReply(
  nativeFeatureChat: NativeFeatureChatServiceLike,
  session: Session,
  command: HbuJwCommand,
  text: string,
  reply: Fragment,
  options: HbuJwHistoryReplyOptions,
): Promise<void> {
  await nativeFeatureChat.sendReply(session, {
    featureId: 'hbu-jw',
    commandId: command.kind,
    userText: hbuJwHistoryUserText(command, text),
    reply,
    summary: options.summary,
    success: options.success ?? true,
    includeReplyPayload: options.includeReplyPayload ?? true,
  });
}

async function sendHbuJwError(
  nativeFeatureChat: NativeFeatureChatServiceLike,
  session: Session,
  command: HbuJwCommand,
  text: string,
  error: unknown,
): Promise<void> {
  const message = toUserMessage(error);
  const sensitive = command.kind === 'confirm';
  const historyMessage = sensitive
    ? message.replaceAll(command.confirmCode, '<确认码已隐藏>')
    : message;
  await sendHbuJwReply(nativeFeatureChat, session, command, text, message, {
    summary: `教务功能未完成：${historyMessage}`,
    success: false,
    includeReplyPayload: !sensitive,
  });
}

export function buildHbuJwCapabilityReference(session: Session, runtime: RuntimeConfig): string {
  const enabled = canUseHbuJwInSession(session, runtime.allowedGroups);
  const direct = session.isDirect === true;
  const groupId = normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
  const bareEnabled = direct || (
    runtime.naturalTriggerEnabled
    && Boolean(groupId && runtime.naturalTriggerGroups.has(groupId))
  );
  const invocation = direct || bareEnabled
    ? '直接发送下面的命令。'
    : '群聊中需要 @机器人 后发送下面的命令。';

  return [
    `教务功能（当前会话${enabled ? '可用' : '未启用'}）：${invocation}`,
    '- 总入口：“教务”，返回完整教务菜单。',
    '- 账号：“教务绑定”、“教务确认 <6位数字确认码>”、“教务状态”、“教务解绑”。',
    '- 查询：“GPA”、“成绩”、“匿名成绩”、“选课结果”、“课表”、“完整课表”、“考试安排”。',
    '- 课程查询帮助：“课程查询”。',
    '- 课程查询严格格式：“课程查询 <课程名关键词或课程号> [学期]”；命令名后必须有空格。',
    '- 学期省略时使用 0（本学期）；也可用 -1、-2 等非正偏移，或完整学期号，例如 2025-2026-2-2；正数偏移无效。',
    '- 课程优先按课程号精确匹配，再按课程名关键词匹配；匹配多门时让用户改用课程号或更完整课程名。',
    enabled
      ? '- 用户写成自然语言或格式错误时，纠正并给出最贴近意图的上述准确命令。'
      : '- 当前群未开启教务功能；说明不可用，不要引导用户反复尝试。',
  ].join('\n');
}

function parseHbuJwCommand(text: string): HbuJwCommand | null {
  if (text === '教务') return { kind: 'menu' };
  if (text === '教务绑定') return { kind: 'bind' };
  if (/^教务(?:确认|确定)\s*$/.test(text)) return { kind: 'confirm_help' };
  const confirm = text.match(/^教务(?:确认|确定)\s+(\d{6})$/);
  if (confirm?.[1]) return { kind: 'confirm', confirmCode: confirm[1] };
  if (text === '教务状态') return { kind: 'status' };
  if (text === '教务解绑') return { kind: 'unbind' };
  if (text.toUpperCase() === 'GPA') return { kind: 'gpa' };
  if (text === '课表') return { kind: 'schedule', mode: 'current-week' };
  if (text === '完整课表') return { kind: 'schedule', mode: 'full-semester' };
  if (text === '选课结果') return { kind: 'selection_result' };
  if (text === '成绩') return { kind: 'term_scores', mode: 'full' };
  if (text === '匿名成绩') return { kind: 'term_scores', mode: 'anonymous' };
  if (text === '课程查询') return { kind: 'course_query_help' };
  const courseQuery = parseCourseQueryCommand(text);
  if (courseQuery) return courseQuery;
  if (text === '考试安排') return { kind: 'exam_schedule' };
  return null;
}

function parseCourseQueryCommand(text: string): HbuJwCommand | null {
  const matched = text.match(/^课程查询\s+(.+)$/);
  if (!matched?.[1]) return null;
  const raw = matched[1].trim();
  if (!raw) return { kind: 'course_query_help' };
  const parts = raw.split(/\s+/);
  const last = parts.at(-1);
  const hasTermInput = Boolean(last && (/^-?\d+$/.test(last) || /^\d{4}-\d{4}-[123]-\d+$/.test(last)));
  const termInput = hasTermInput ? last : undefined;
  const courseQuery = (hasTermInput ? parts.slice(0, -1) : parts).join(' ').trim();
  if (!courseQuery) return { kind: 'course_query_help' };
  return { kind: 'course_query', courseQuery, termInput };
}

function canUseHbuJwInSession(session: Session, allowedGroups: Set<string>): boolean {
  const carrier = session as Session & { isDirect?: boolean; guildId?: string | null; channelId?: string | null };
  if (carrier.isDirect === true) return true;
  const groupId = normalizeGroupId(carrier.guildId) ?? normalizeGroupId(carrier.channelId);
  return Boolean(groupId && allowedGroups.has(groupId));
}

function canInvokeHbuJwInSession(session: Session, naturalTriggerEnabled: boolean, naturalTriggerGroups: Set<string>): boolean {
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
    throw new HbuJwUserError('当前会话缺少 QQ 身份信息，无法绑定教务。');
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
  setNoStore(koaCtx);
  koaCtx.body = html;
}

function writeRedirect(koaCtx: any, location: string): void {
  koaCtx.status = 303;
  koaCtx.set('location', location);
  setNoStore(koaCtx);
  koaCtx.body = '';
}

function bindPageLocation(runtime: RuntimeConfig, token: string): string {
  return `${runtime.bindPagePath}?token=${encodeURIComponent(token)}`;
}

function setNoStore(koaCtx: any): void {
  koaCtx.set('cache-control', 'no-store');
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
  if (error instanceof HbuJwUserError) return error.message;
  logger.warn('hbu jw operation failed: %s', error instanceof Error ? error.message : String(error));
  return '教务绑定处理失败，请稍后重试。';
}
