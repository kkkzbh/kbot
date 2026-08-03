import { Context, Logger, Schema, type Session } from 'koishi';
import {
  loadStickerCatalog,
  type LoadedStickerCatalog,
  type StickerCapabilityState,
} from './selection.js';
import {
  resolveChatLunaRoomLike,
  type QqbotChatLunaContextOptionsLike,
} from '../shared/chatluna-conversation.js';
import type { ModelRuntimeClient } from '../model-config/index.js';
import {
  StickerMaintenanceService,
  type StickerMaintenanceServiceLike,
} from './maintenance.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

export const name = 'chatluna-sticker';
export const inject = {
  required: ['chatluna', 'modelRuntime'],
} as const;
export {
  createStickerHistoryLine,
  resolveStickerSelection,
  type LoadedStickerEntry,
  type StickerCapabilityState,
  type StickerCatalogDocument,
  type StickerCatalogEntry,
  type StickerMatch,
} from './selection.js';
export {
  StickerMaintenanceService,
  type StickerIndexMaintenanceResult,
  type StickerMaintenanceServiceLike,
} from './maintenance.js';

const logger = new Logger(name);
let runtimeStickerDir = '';
let runtimeStickerCatalog: LoadedStickerCatalog | null | undefined;

export interface Config {
  stickerDir?: string;
}

export const Config: Schema<Config> = Schema.object({
  stickerDir: Schema.string()
    .description('表情包目录路径（包含 catalog.generated.json 与 images/ 子目录）。'),
});

type SessionWithStickerState = Session & {
  state?: Record<string, unknown> & {
    qqSticker?: StickerCapabilityState;
  };
};

type MiddlewareContextLike = {
  options?: QqbotChatLunaContextOptionsLike;
};

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => unknown;
};

type ChatLunaLike = {
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => ChainHookBuilder;
  };
};

type ContextWithChatLuna = Context & {
  chatluna?: ChatLunaLike;
  modelRuntime: ModelRuntimeClient;
  get?: (name: string) => unknown;
  provide?: (name: string) => void;
  set?: (name: string, value: unknown) => void;
};

function isReplyPlanSessionAvailable(session: Session): boolean {
  return session.platform === 'onebot' && Boolean(session.channelId);
}

function setStickerCapabilityState(session: SessionWithStickerState, capability: StickerCapabilityState): void {
  const current = session.state ?? {};
  current.qqSticker = capability;
  session.state = current;
}

function resolveChatLunaService(ctx: ContextWithChatLuna): ChatLunaLike | undefined {
  const byGetter = typeof ctx.get === 'function' ? (ctx.get('chatluna') as ChatLunaLike | undefined) : undefined;
  return byGetter ?? ctx.chatluna;
}

function loadRuntimeStickerCatalog(): LoadedStickerCatalog | null {
  if (!runtimeStickerDir) return null;
  if (runtimeStickerCatalog !== undefined) {
    return runtimeStickerCatalog ?? null;
  }
  runtimeStickerCatalog = loadStickerCatalog(runtimeStickerDir);
  return runtimeStickerCatalog ?? null;
}

function setRuntimeStickerCatalog(stickerDir: string, catalog: LoadedStickerCatalog | null): void {
  runtimeStickerDir = stickerDir;
  runtimeStickerCatalog = catalog;
}

export function resolveStickerCapabilityArtifacts(preset?: string | null): {
  state: StickerCapabilityState;
} {
  const normalizedPreset = preset?.trim() || null;
  const catalog = loadRuntimeStickerCatalog();
  const availableCount =
    catalog?.entries.filter(
      (entry) => entry.scopes.includes('global') || (normalizedPreset ? entry.scopes.includes(`persona:${normalizedPreset}`) : false),
    ).length ?? 0;
  const state: StickerCapabilityState = {
    catalog: catalog ?? null,
    preset: normalizedPreset,
    availableCount,
  };
  return { state };
}

export function apply(ctx: Context, config: Config): void {
  const stickerDir = config.stickerDir?.trim();
  if (!stickerDir) {
    throw new Error('表情包配置缺失：stickerDir。默认值必须由 koishi.yml 显式传入。');
  }
  const catalog = loadStickerCatalog(stickerDir);
  setRuntimeStickerCatalog(stickerDir, catalog);
  if (!catalog?.entries.length) {
    logger.warn('sticker catalog is unavailable: %s/%s', stickerDir, 'catalog.generated.json');
  } else {
    logger.info('loaded sticker catalog with %d entry(ies).', catalog.entries.length);
  }
  const runtimeCtx = ctx as ContextWithChatLuna;
  const maintenance = new StickerMaintenanceService({
    stickerDir,
    modelRuntime: runtimeCtx.modelRuntime,
    onCatalogWritten: () => {
      const updatedCatalog = loadStickerCatalog(stickerDir);
      if (!updatedCatalog) {
        throw new Error('刚写入的 sticker catalog 无法加载。');
      }
      setRuntimeStickerCatalog(stickerDir, updatedCatalog);
      logger.info('reloaded sticker catalog with %d entry(ies).', updatedCatalog.entries.length);
    },
  });
  provideStickerMaintenance(runtimeCtx, maintenance);

  let policyRegistered = false;
  const ensurePolicyRegistered = (): boolean => {
    if (policyRegistered) return true;
    const chatluna = resolveChatLunaService(ctx as ContextWithChatLuna);
    const chain = chatluna?.chatChain;
    if (!chain) return false;

    chain
      .middleware('qqbot_sticker_policy', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithStickerState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const room = resolveChatLunaRoomLike(context.options);
        const preset = room?.preset?.trim() || null;
        const { state } = resolveStickerCapabilityArtifacts(preset);
        setStickerCapabilityState(session, state);
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('resolve_conversation')
      .after('read_chat_message')
      .before('lifecycle-handle_command');
    policyRegistered = true;
    return true;
  };

  ctx.on('ready', () => {
    ensurePolicyRegistered();
  });

  ctx.on('chatluna/chat-chain-added', () => {
    ensurePolicyRegistered();
  });
}

function provideStickerMaintenance(
  ctx: ContextWithChatLuna,
  service: StickerMaintenanceServiceLike,
): void {
  if (typeof ctx.provide !== 'function' || typeof ctx.set !== 'function') {
    throw new Error('Koishi context cannot provide stickerMaintenance.');
  }
  ctx.provide('stickerMaintenance');
  ctx.set('stickerMaintenance', service);
}
