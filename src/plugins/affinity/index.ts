import { Context, Logger, Schema, type Session } from 'koishi';
import type { AffinityServiceLike } from '../../types/affinity.js';
import { AffinityService, getSessionAffinityResult, type AffinityDatabaseLike } from './service.js';
import { AffinityRandomPlanScheduler } from './scheduler.js';
import { isAffinityPanelCommandSession } from './command.js';
import { renderAffinityPanelImage, type AffinityPanelPuppeteerLike } from './panel.js';
import {
  resolveChatLunaRoomLike,
  type QqbotChatLunaContextOptionsLike,
} from '../shared/chatluna-conversation.js';
import type {
  ModelConfigService,
  ModelRuntimeClient,
} from '../model-config/index.js';
export {
  AffinityService,
  affinityMutationResponse,
  createUnavailableAffinityState,
  getSessionAffinityResult,
  setSessionAffinityResult,
} from './service.js';
export {
  createRandomScheduleTimes,
  resolveAffinityEvent,
  selectRandomCount,
} from './public.js';
export { isAffinityPanelCommandSession } from './command.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { CONTINUE: number };
};

export const name = 'affinity';
export const inject = {
  required: ['database', 'puppeteer', 'chatluna', 'modelConfig', 'modelRuntime', 'toolPolicy'],
} as const;

const logger = new Logger(name);
const allowReplyResolverName = 'qqbot-affinity';

export interface Config {
  enabled?: boolean;
  proactiveEnabled?: boolean;
  pollIntervalMs?: number;
  randomWindowStartHour?: number;
  randomWindowEndHour?: number;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().description('是否启用关系事件系统。'),
  proactiveEnabled: Schema.boolean().description('是否启用主动随机事件。'),
  pollIntervalMs: Schema.natural().role('time').description('主动随机事件轮询周期（毫秒）。'),
  randomWindowStartHour: Schema.natural().description('主动随机事件每日开始小时。'),
  randomWindowEndHour: Schema.natural().description('主动随机事件每日结束小时。'),
});

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => ChainHookBuilder;
};

type ChatLunaLike = {
  registerAllowReplyResolver?: (
    name: string,
    resolver: (arg: { session: Session; context: unknown }) => boolean | void | Promise<boolean | void>,
  ) => () => void;
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => ChainHookBuilder;
  };
};

type MiddlewareContextLike = {
  options?: QqbotChatLunaContextOptionsLike;
};

type AffinityServices = {
  database: any;
  chatluna: ChatLunaLike;
  bots?: Array<{
    selfId?: string;
    platform?: string;
    sendMessage: (...args: any[]) => Promise<unknown>;
  }>;
  affinity?: AffinityServiceLike;
  modelConfig: ModelConfigService;
  modelRuntime: ModelRuntimeClient;
  puppeteer: AffinityPanelPuppeteerLike;
};

type CommandRegistrationLike = {
  action(callback: (argv: { session?: Session }) => unknown): unknown;
};

type AffinityCommandContextLike = {
  command(name: string, description?: string): CommandRegistrationLike;
  puppeteer: AffinityPanelPuppeteerLike;
};

export function registerAffinityPanelCommand(
  ctx: AffinityCommandContextLike,
  service: AffinityServiceLike,
  commandLogger = logger,
): void {
  ctx.command('好感', '查看与丰川祥子的关系面板').action(async ({ session }) => {
    if (!session?.userId) return '无法识别当前用户。';
    try {
      const panelView = await service.buildPanelView(session);
      const image = await renderAffinityPanelImage(ctx.puppeteer, panelView);
      await session.send(image);
      await session.send(panelView.fixedLine);
      await service.syncPanelCommandToChatHistory(session, panelView);
    } catch (error) {
      commandLogger.warn('affinity panel command failed: %s', error instanceof Error ? error.message : String(error));
      return '关系面板生成失败。';
    }
  });
}

function resolveChatLunaService(ctx: AffinityServices): ChatLunaLike {
  const carrier = ctx as unknown as { get?: (name: string) => unknown; chatluna?: ChatLunaLike };
  const fromGetter = typeof carrier.get === 'function'
    ? carrier.get.call(ctx, 'chatluna') as ChatLunaLike | undefined
    : undefined;
  const chatluna = fromGetter ?? carrier.chatluna;
  if (!chatluna) {
    throw new Error('affinity requires chatluna service.');
  }
  return chatluna;
}

function requireBooleanConfig(config: Config, key: keyof Config): boolean {
  const value = config[key];
  if (typeof value !== 'boolean') {
    throw new Error(`关系事件配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return value;
}

function requireNaturalConfig(config: Config, key: keyof Config, min = 1): number {
  const value = Number(config[key]);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`关系事件配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return Math.floor(value);
}

function ensureAffinityTables(ctx: Context): void {
  ctx.model.extend(
    'affinity_config',
    {
      id: 'unsigned',
      key: 'string',
      value: 'text',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      unique: ['key'],
    },
  );

  ctx.model.extend(
    'affinity_scope_config',
    {
      id: 'unsigned',
      characterId: 'string',
      scopeKind: 'string',
      scopeId: 'string',
      enabled: 'unsigned',
      proactiveEnabled: 'unsigned',
      label: { type: 'text', nullable: true },
      platform: { type: 'string', nullable: true },
      botSelfId: { type: 'string', nullable: true },
      channelId: { type: 'string', nullable: true },
      guildId: { type: 'string', nullable: true },
      conversationId: { type: 'string', nullable: true },
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['characterId', 'scopeKind', 'scopeId'], ['scopeKind', 'scopeId']],
    },
  );

  ctx.model.extend(
    'affinity_user_state',
    {
      id: 'unsigned',
      characterId: 'string',
      userKey: 'string',
      platform: 'string',
      userId: 'string',
      displayName: { type: 'text', nullable: true },
      trust: 'double',
      familiarity: 'double',
      comfort: 'double',
      tension: 'double',
      mood: 'string',
      attentionHeat: 'double',
      energy: 'double',
      stage: 'string',
      flags: { type: 'text', nullable: true },
      unlockedScenes: { type: 'text', nullable: true },
      dailyState: { type: 'text', nullable: true },
      weeklyState: { type: 'text', nullable: true },
      lastSeenAt: 'double',
      lastUpdatedAt: 'double',
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['characterId', 'userKey'], ['updatedAt']],
    },
  );

  ctx.model.extend(
    'affinity_event',
    {
      id: 'unsigned',
      characterId: 'string',
      userKey: { type: 'string', nullable: true },
      scopeKind: 'string',
      scopeId: 'string',
      platform: 'string',
      botSelfId: { type: 'string', nullable: true },
      channelId: { type: 'string', nullable: true },
      guildId: { type: 'string', nullable: true },
      conversationId: { type: 'string', nullable: true },
      messageId: { type: 'string', nullable: true },
      eventType: 'string',
      effectTier: 'string',
      route: 'string',
      confidence: 'double',
      reasonCode: 'string',
      deltaJson: { type: 'text', nullable: true },
      beforeJson: { type: 'text', nullable: true },
      afterJson: { type: 'text', nullable: true },
      evidence: { type: 'text', nullable: true },
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['characterId', 'userKey'], ['scopeKind', 'scopeId'], ['createdAt']],
    },
  );

  ctx.model.extend(
    'affinity_random_plan',
    {
      id: 'unsigned',
      planKey: 'string',
      characterId: 'string',
      triggerKind: 'string',
      scopeKind: 'string',
      scopeId: 'string',
      platform: { type: 'string', nullable: true },
      botSelfId: { type: 'string', nullable: true },
      channelId: { type: 'string', nullable: true },
      guildId: { type: 'string', nullable: true },
      conversationId: { type: 'string', nullable: true },
      dayKey: 'string',
      slotIndex: 'unsigned',
      direction: 'string',
      scheduledAt: 'double',
      status: 'string',
      messageText: { type: 'text', nullable: true },
      skipReason: { type: 'text', nullable: true },
      sentAt: { type: 'double', nullable: true },
      deliveryState: { type: 'string', initial: 'not_started' },
      deliveryAttemptId: { type: 'string', nullable: true },
      deliveryReceipt: { type: 'text', nullable: true },
      deliveryPayloadJson: { type: 'text', nullable: true },
      deliveryConfirmedAt: { type: 'double', nullable: true },
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      unique: ['planKey'],
      indexes: [
        ['characterId', 'scopeKind', 'scopeId', 'dayKey'],
        ['status', 'scheduledAt'],
        ['deliveryState'],
      ],
    },
  );

  ctx.model.extend(
    'affinity_open_thread',
    {
      id: 'unsigned',
      sourcePlanId: { type: 'unsigned', nullable: true },
      characterId: 'string',
      scopeKind: 'string',
      scopeId: 'string',
      userKey: { type: 'string', nullable: true },
      threadType: 'string',
      title: 'text',
      summary: 'text',
      status: 'string',
      payloadJson: { type: 'text', nullable: true },
      expiresAt: 'double',
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['characterId', 'scopeKind', 'scopeId', 'status'], ['sourcePlanId'], ['expiresAt']],
    },
  );

  ctx.model.extend(
    'affinity_random_memory',
    {
      id: 'unsigned',
      characterId: 'string',
      scopeKind: 'string',
      scopeId: 'string',
      direction: 'string',
      sourcePlanId: { type: 'unsigned', nullable: true },
      messageText: 'text',
      contextSummary: { type: 'text', nullable: true },
      materialJson: { type: 'text', nullable: true },
      responseSummary: { type: 'text', nullable: true },
      responderNames: { type: 'text', nullable: true },
      createdAt: 'double',
      lastResponseAt: { type: 'double', nullable: true },
      expiresAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['characterId', 'scopeKind', 'scopeId'], ['sourcePlanId'], ['expiresAt']],
    },
  );

  ctx.model.extend(
    'affinity_audit',
    {
      id: 'unsigned',
      eventType: 'string',
      characterId: 'string',
      userKey: { type: 'string', nullable: true },
      scopeKind: { type: 'string', nullable: true },
      scopeId: { type: 'string', nullable: true },
      detail: { type: 'text', nullable: true },
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['eventType'], ['createdAt']],
    },
  );
}

export function apply(ctx: Context, config: Config): void {
  const runtime = {
    enabled: requireBooleanConfig(config, 'enabled'),
    proactiveEnabled: requireBooleanConfig(config, 'proactiveEnabled'),
    pollIntervalMs: requireNaturalConfig(config, 'pollIntervalMs', 1000),
    randomWindowStartHour: requireNaturalConfig(config, 'randomWindowStartHour', 0),
    randomWindowEndHour: requireNaturalConfig(config, 'randomWindowEndHour', 1),
  };
  void runtime.randomWindowStartHour;
  void runtime.randomWindowEndHour;

  const serviceCtx = ctx as unknown as AffinityServices;
  ensureAffinityTables(ctx);
  const database = (ctx as unknown as { database: AffinityDatabaseLike }).database;
  const service = new AffinityService(
    database,
    serviceCtx.modelConfig,
    serviceCtx.modelRuntime,
    () => (((ctx as unknown as { bots?: unknown[] }).bots ?? []) as any[]),
    Math.random,
    () => resolveChatLunaService(serviceCtx) as any,
  );
  service.setRuntimeGate(runtime.enabled, runtime.proactiveEnabled);
  const provider = ctx as unknown as {
    provide?: (name: string) => void;
    set?: (name: string, value: unknown) => void;
    affinity?: AffinityServiceLike;
  };
  if (typeof provider.provide === 'function' && typeof provider.set === 'function') {
    provider.provide('affinity');
    provider.set('affinity', service);
  } else {
    provider.affinity = service;
  }

  let disposeAllowReplyResolver: (() => void) | null = null;
  let randomScheduler: AffinityRandomPlanScheduler | null = null;
  let chatlunaHooksRegistered = false;
  service.setScheduleRefreshCallback(() => randomScheduler?.refreshSoon('service-change'));

  if (runtime.enabled) {
    ctx.middleware(async (session, next) => {
      try {
        if (!isAffinityPanelCommandSession(session)) {
          await service.processIncomingSession(session);
        }
      } catch (error) {
        logger.warn('affinity incoming processing skipped: %s', error instanceof Error ? error.message : String(error));
      }
      return next();
    });
  }

  registerAffinityPanelCommand(serviceCtx as unknown as AffinityCommandContextLike, service);

  const registerChatLunaHooks = (): boolean => {
    if (chatlunaHooksRegistered) return true;
    const chatluna = resolveChatLunaService(serviceCtx);
    if (!chatluna.chatChain) return false;
    if (typeof chatluna.registerAllowReplyResolver !== 'function') {
      throw new Error('affinity requires chatluna.registerAllowReplyResolver.');
    }
    disposeAllowReplyResolver = chatluna.registerAllowReplyResolver(allowReplyResolverName, ({ session }) => {
      const result = getSessionAffinityResult(session);
      if (result?.shouldAllowReply) return true;
    });
    logger.info('affinity allow reply resolver registered.');

    chatluna.chatChain
      .middleware('qqbot_affinity_prompt_context', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MiddlewareContextLike;
        const conversationId = resolveChatLunaRoomLike(context.options)?.conversationId?.trim();
        if (conversationId) {
          await service.injectPromptForTurn(conversationId, session);
        }
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('resolve_conversation')
      .after('qqbot_turn_context')
      .before('lifecycle-handle_command');
    chatlunaHooksRegistered = true;
    logger.info('affinity prompt middleware registered.');
    return true;
  };

  ctx.on('ready', async () => {
    const cleanedRandomMemories = await service.normalizeStoredRandomMemoryPromptText();
    if (cleanedRandomMemories > 0) {
      logger.info('cleaned %d affinity random memory prompt text row(s).', cleanedRandomMemories);
    }

    registerChatLunaHooks();

    if (runtime.enabled) {
      randomScheduler = new AffinityRandomPlanScheduler(service, {
        safetyIntervalMs: Math.max(60_000, runtime.pollIntervalMs),
        logger,
      });
      randomScheduler.start();
    }
    logger.info('affinity service registered.');
  });

  ctx.on('chatluna/chat-chain-added', () => {
    registerChatLunaHooks();
  });

  ctx.on('dispose', () => {
    disposeAllowReplyResolver?.();
    disposeAllowReplyResolver = null;
    randomScheduler?.dispose();
    randomScheduler = null;
  });
}
