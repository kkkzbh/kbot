import '@koishijs/plugin-console';
import { join } from 'node:path';
import { Context, Logger } from 'koishi';
import { BotConsoleManager, resolveBotEnvFiles } from './server.js';
import { CopilotOAuthBridgeService } from '../copilot-oauth/index.js';
import { CodexOAuthBridgeService } from '../codex-oauth/index.js';
import {
  canHotSwitchMainChatModelOnly,
  mainChatRuntimeState,
} from '../shared/llm/main-chat-runtime.js';
import {
  normalizeMainChatBuiltinTabId,
  resolveMainChatRuntimeProfileFromTabConfig,
} from '../shared/llm/index.js';
import type {
  BotConsoleProbeResult,
  BotConsoleMemoryEditRequest,
  BotConsoleMemoryForgetRequest,
  BotConsoleMemoryMutationResponse,
  BotConsoleMemoryReviewRequest,
  BotConsoleMemoryState,
  BotConsoleMemoryVisibilityRequest,
  BotConsoleState,
  BotServiceUnit,
  CopilotAuthCancelResponse,
  CopilotAuthLogoutResponse,
  CopilotAuthPollResponse,
  CopilotAuthStartResponse,
  CopilotAuthStatusResponse,
  CodexAuthCancelResponse,
  CodexAuthLogoutResponse,
  CodexAuthPollResponse,
  CodexAuthStartResponse,
  CodexAuthStatusResponse,
  ClearConversationHistoryRequest,
  ClearConversationHistoryResponse,
  CopilotModelListResponse,
  CodexModelListResponse,
  DeepSeekModelListResponse,
  MimoModelListResponse,
  DeleteConversationRoomRequest,
  DeleteConversationRoomResponse,
  EnvPatch,
  PresetDocument,
  ReorderPresetsResponse,
  AdjustAffinityUserRequest,
  AdjustAffinityUserResponse,
  SaveFeatureOverridesRequest,
  SaveFeatureOverridesResponse,
  SaveAffinitySettingsRequest,
  SaveAffinitySettingsResponse,
  SaveAffinityWhitelistRequest,
  SaveAffinityWhitelistResponse,
  SaveModelTabsRequest,
  SaveModelTabsResponse,
  SaveTtsSettingsRequest,
  SaveTtsSettingsResponse,
  SaveToolOverridesRequest,
  SaveToolOverridesResponse,
  ServiceAction,
  SynthesizeTtsSampleRequest,
  SynthesizeTtsSampleResponse,
} from '../../types/bot-console.js';
import type { FeaturePolicyServiceLike } from '../../types/feature-policy.js';
import type { AffinityServiceLike } from '../../types/affinity.js';
import type { MemoryStatusServiceLike } from '../../types/memory.js';
import type { ToolPolicyServiceLike } from '../../types/tool-policy.js';
import { createUnavailableAffinityState } from '../affinity/index.js';
import { createUnavailableMemoryStatusSnapshot } from '../shared/memory-status.js';
import { buildMemoryState, createUnavailableMemoryState } from './memory.js';
import {
  AffinityBridgeHttpError,
  parseAffinityRandomPlanBridgeRequest,
} from './affinity-bridge.js';
import {
  parseQqVoiceBridgeRequest,
  QqVoiceBridgeHttpError,
  sendVoiceByBridge,
  validateVoiceBridgeAuthHeader,
} from './voice-bridge.js';

const logger = new Logger('bot-console');

export const name = 'bot-console';
export const inject = { required: ['console'], optional: ['server', 'memoryStatus', 'featurePolicy', 'toolPolicy', 'affinity', 'database'] } as const;

const CONSOLE_CLIENT_ASSET_DIR = 'dist/node_modules/@qqbot/bot-console-client';
const LISTENER_AUTHORITY = 4;

function ensureRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求数据格式不正确。');
  }
  return value as Record<string, unknown>;
}

type RuntimeServiceContext = {
  memoryStatus?: MemoryStatusServiceLike;
  featurePolicy?: FeaturePolicyServiceLike;
  toolPolicy?: ToolPolicyServiceLike;
  affinity?: AffinityServiceLike;
  database?: {
    get: (table: string, query: Record<string, unknown>) => Promise<any[]>;
    set?: (table: string, query: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
    create?: (table: string, row: Record<string, unknown>) => Promise<Record<string, unknown>>;
    remove?: (table: string, query: Record<string, unknown>) => Promise<unknown>;
  };
};

function resolveDirtyModelTabIds(input: unknown): Set<SaveModelTabsRequest['activeTab']> {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('保存模型 Tab 必须携带已修改的 Tab 列表。');
  }
  const result = new Set<SaveModelTabsRequest['activeTab']>();
  for (const value of input) {
    result.add(normalizeMainChatBuiltinTabId(value) as SaveModelTabsRequest['activeTab']);
  }
  return result;
}

async function buildState(ctx: RuntimeServiceContext, manager: BotConsoleManager): Promise<BotConsoleState> {
  const statePromise = manager.getState();
  let memory = createUnavailableMemoryStatusSnapshot();
  if (ctx.memoryStatus) {
    try {
      memory = await ctx.memoryStatus.getSnapshot();
    } catch {
      memory = createUnavailableMemoryStatusSnapshot();
    }
  }
  const featureScopesPromise = ctx.featurePolicy?.listConsoleFeatureScopes?.() ?? Promise.resolve([]);
  const featureOverridesPromise = ctx.featurePolicy?.getFeatureOverrides?.() ?? Promise.resolve([]);
  const conversationTargetsPromise = ctx.featurePolicy?.listConversationTargets?.() ?? Promise.resolve([]);
  const affinityPromise = ctx.affinity?.getConsoleState?.() ?? Promise.resolve(createUnavailableAffinityState());
  const toolPolicyPromise = ctx.toolPolicy?.getToolPolicyState?.() ?? Promise.resolve({
    catalog: [],
    routeProfiles: [],
    routeProfileInfo: [],
    defaultScopes: [],
    scopes: [],
    overrides: [],
    conversationTargets: [],
  });

  const [state, featureScopes, featureOverrides, conversationTargets, affinity, toolPolicy] = await Promise.all([
    statePromise,
    featureScopesPromise,
    featureOverridesPromise,
    conversationTargetsPromise,
    affinityPromise,
    toolPolicyPromise,
  ]);

  return {
    ...state,
    featureScopes,
    featureOverrides,
    conversationTargets,
    affinity,
    toolPolicy: {
      ...toolPolicy,
      conversationTargets: toolPolicy.conversationTargets.length > 0 ? toolPolicy.conversationTargets : conversationTargets,
    },
    runtimeStatus: {
      memory,
      tts: state.tts.health,
    },
  };
}

export function apply(ctx: Context): void {
  const envFiles = resolveBotEnvFiles(ctx.baseDir);
  const copilotBridge = new CopilotOAuthBridgeService({
    rootDir: ctx.baseDir,
    envFiles,
  });
  const codexBridge = new CodexOAuthBridgeService({
    rootDir: ctx.baseDir,
    envFiles,
  });
  const manager = new BotConsoleManager({ rootDir: ctx.baseDir, copilotBridge, codexBridge });
  const consoleService = ctx.console as any;
  const runtimeCtx = ctx as unknown as RuntimeServiceContext;
  // Koishi console production asset serving rejects local plugin client files outside node_modules.
  const entryDir = join(ctx.baseDir, CONSOLE_CLIENT_ASSET_DIR);

  try {
    manager.syncManagedChatLunaAgentConfig();
  } catch (error) {
    logger.warn('failed to sync chatluna-agent config: %s', error instanceof Error ? error.message : String(error));
  }

  consoleService.addEntry(
    {
      dev: join(entryDir, 'index.js'),
      prod: entryDir,
    },
    () => ({
      title: '机器人控制台',
    }),
  );

  consoleService.addListener(
    'bot-console/get-state',
    async () => {
      return buildState(runtimeCtx, manager);
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/run-status-probe',
    async (target: string): Promise<BotConsoleProbeResult> => {
      const normalizedTarget = String(target ?? '');
      if (normalizedTarget !== 'embedding' && normalizedTarget !== 'extraction' && normalizedTarget !== 'provider') {
        throw new Error('不支持这个探测目标。');
      }

      const probe =
        normalizedTarget === 'embedding'
          ? runtimeCtx.memoryStatus?.probeEmbedding
          : normalizedTarget === 'extraction'
            ? runtimeCtx.memoryStatus?.probeExtraction
            : runtimeCtx.memoryStatus?.probeProvider;
      const memory =
        probe != null
          ? await probe.call(runtimeCtx.memoryStatus)
          : {
              target: normalizedTarget as BotConsoleProbeResult['target'],
              ok: false,
              checkedAt: Date.now(),
              latencyMs: null,
              error: 'memory status service unavailable',
              snapshot: createUnavailableMemoryStatusSnapshot(),
            };

      return {
        target: normalizedTarget as BotConsoleProbeResult['target'],
        memory,
      };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/get-memory-state',
    async (): Promise<BotConsoleMemoryState> => {
      try {
        const status = runtimeCtx.memoryStatus ? await runtimeCtx.memoryStatus.getSnapshot() : createUnavailableMemoryStatusSnapshot();
        return await buildMemoryState(runtimeCtx.database, status);
      } catch (error) {
        logger.warn('failed to build memory console state: %s', error instanceof Error ? error.message : String(error));
        return createUnavailableMemoryState(createUnavailableMemoryStatusSnapshot());
      }
    },
    { authority: LISTENER_AUTHORITY },
  );

  async function mutateMemoryState(
    handler: (store: import('../memory/store.js').MemoryStore) => Promise<boolean>,
  ): Promise<BotConsoleMemoryMutationResponse> {
    if (!runtimeCtx.database?.get || !runtimeCtx.database.set || !runtimeCtx.database.create || !runtimeCtx.database.remove) {
      throw new Error('memory database service unavailable');
    }
    const { MemoryStore } = await import('../memory/store.js');
    const store = new MemoryStore(runtimeCtx.database as any);
    const ok = await handler(store);
    const status = runtimeCtx.memoryStatus ? await runtimeCtx.memoryStatus.getSnapshot() : createUnavailableMemoryStatusSnapshot();
    return {
      ok,
      memory: await buildMemoryState(runtimeCtx.database, status),
    };
  }

  consoleService.addListener(
    'bot-console/memory/update-visibility',
    async (payload: BotConsoleMemoryVisibilityRequest): Promise<BotConsoleMemoryMutationResponse> => {
      const record = ensureRecord(payload);
      return mutateMemoryState((store) => store.updateVisibility({
        userKey: String(record.userKey ?? ''),
        type: record.type === 'episode' ? 'episode' : 'fact',
        id: Number(record.id),
        visibility: String(record.visibility ?? '') as BotConsoleMemoryVisibilityRequest['visibility'],
      }));
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/memory/edit',
    async (payload: BotConsoleMemoryEditRequest): Promise<BotConsoleMemoryMutationResponse> => {
      const record = ensureRecord(payload);
      return mutateMemoryState((store) => store.editMemory({
        userKey: String(record.userKey ?? ''),
        type: record.type === 'episode' ? 'episode' : 'fact',
        id: Number(record.id),
        content: String(record.content ?? ''),
      }));
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/memory/forget',
    async (payload: BotConsoleMemoryForgetRequest): Promise<BotConsoleMemoryMutationResponse> => {
      const record = ensureRecord(payload);
      return mutateMemoryState(async (store) => {
        const userKey = String(record.userKey ?? '');
        if (record.all === true) return (await store.forgetAll(userKey)) > 0;
        if (typeof record.topicKey === 'string' && record.topicKey.trim()) {
          return (await store.forgetTopic(userKey, record.topicKey.trim(), typeof record.contextKey === 'string' ? record.contextKey : null)) > 0;
        }
        if (typeof record.contextKey === 'string' && record.contextKey.trim()) {
          return (await store.forgetContext(userKey, record.contextKey.trim())) > 0;
        }
        return store.forgetMemory({
          userKey,
          type: record.type === 'episode' ? 'episode' : 'fact',
          id: Number(record.id),
        });
      });
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/memory/review',
    async (payload: BotConsoleMemoryReviewRequest): Promise<BotConsoleMemoryMutationResponse> => {
      const record = ensureRecord(payload);
      return mutateMemoryState((store) => store.reviewCandidate({
        candidateId: Number(record.candidateId),
        action: record.action === 'reject' ? 'reject' : record.action === 'private' ? 'private' : 'approve',
      }));
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/memory/export',
    async (userKey: string) => {
      if (!runtimeCtx.database?.get) throw new Error('memory database service unavailable');
      const [facts, episodes, provenance] = await Promise.all([
        runtimeCtx.database.get('memory_fact', { ownerUserKey: String(userKey ?? '') }),
        runtimeCtx.database.get('memory_episode', { ownerUserKey: String(userKey ?? '') }),
        runtimeCtx.database.get('memory_provenance', { ownerUserKey: String(userKey ?? '') }),
      ]);
      return { userKey, facts, episodes, provenance };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/get-preset',
    async (name: string) => {
      return manager.getPreset(String(name ?? ''));
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/save-env',
    async (payload: unknown) => {
      const record = ensureRecord(payload);
      const patch: EnvPatch = {};
      for (const [key, value] of Object.entries(record)) {
        patch[key] = value == null ? null : String(value);
      }
      const env = await manager.saveEnv(patch);
      return { env, restartRequired: true };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/save-tts-settings',
    async (payload: SaveTtsSettingsRequest): Promise<SaveTtsSettingsResponse> => {
      const record = ensureRecord(payload);
      return manager.saveTtsSettings({
        botEnv: record.botEnv && typeof record.botEnv === 'object' && !Array.isArray(record.botEnv)
          ? record.botEnv as SaveTtsSettingsRequest['botEnv']
          : {},
        localEnv: record.localEnv && typeof record.localEnv === 'object' && !Array.isArray(record.localEnv)
          ? record.localEnv as SaveTtsSettingsRequest['localEnv']
          : {},
      });
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/probe-tts-health',
    async () => {
      return { health: await manager.probeTtsHealth() };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/synthesize-tts-sample',
    async (payload: SynthesizeTtsSampleRequest): Promise<SynthesizeTtsSampleResponse> => {
      const record = ensureRecord(payload);
      return manager.synthesizeTtsSample({
        text: String(record.text ?? ''),
        style: record.style === 'black' ? 'black' : 'white',
      });
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/save-model-tabs',
    async (payload: SaveModelTabsRequest): Promise<SaveModelTabsResponse> => {
      try {
        const record = ensureRecord(payload);
        const result = await manager.saveModelTabs({
          activeTab: String(record.activeTab ?? '') as SaveModelTabsRequest['activeTab'],
          tabs: Array.isArray(record.tabs) ? (record.tabs as SaveModelTabsRequest['tabs']) : [],
          dirtyTabIds: Array.isArray(record.dirtyTabIds)
            ? (record.dirtyTabIds as SaveModelTabsRequest['dirtyTabIds'])
            : [],
        });
        const dirtyIds = resolveDirtyModelTabIds(record.dirtyTabIds);
        const nextProfile = resolveMainChatRuntimeProfileFromTabConfig(result.modelTabs.activeTab, result.modelTabs.tabs);
        const currentProfile = mainChatRuntimeState.getProfile();
        const hotSwitchable =
          dirtyIds.size === 1 &&
          dirtyIds.has(nextProfile.tabId) &&
          canHotSwitchMainChatModelOnly(currentProfile, nextProfile);
        const hotSwitched = hotSwitchable ? mainChatRuntimeState.hotSwitchModel(nextProfile) : false;
        return {
          ...result,
          hotSwitched,
          restartRequired: !hotSwitchable,
          restartReason: hotSwitchable ? null : 'provider、接口地址、密钥或 OAuth 动态模型注册变更需要重启 Koishi。',
        };
      } catch (err) {
        // Re-throw with a freshly constructed Error so the message survives koishi's IPC
        // serialization (the original Error sometimes loses its `message` across the wire,
        // leaving the client with a useless generic toast).
        const message = err instanceof Error
          ? err.message || err.stack?.split('\n', 1)[0] || '保存模型 Tab 失败'
          : typeof err === 'string'
            ? err
            : (() => {
                try { return JSON.stringify(err); } catch { return '保存模型 Tab 失败'; }
              })();
        throw new Error(`bot-console/save-model-tabs: ${message}`);
      }
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/list-deepseek-models',
    async (payload: unknown): Promise<DeepSeekModelListResponse> => {
      const record = ensureRecord(payload);
      return manager.listDeepSeekModels({
        baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
        apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
      });
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/list-copilot-models',
    async (): Promise<CopilotModelListResponse> => {
      return manager.listCopilotModels();
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/list-codex-models',
    async (): Promise<CodexModelListResponse> => {
      return manager.listCodexModels();
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/list-mimo-models',
    async (payload: unknown): Promise<MimoModelListResponse> => {
      const record = ensureRecord(payload);
      return manager.listMimoModels({
        baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
        apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
      });
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/copilot-auth/start',
    async (): Promise<CopilotAuthStartResponse> => {
      return copilotBridge.startLogin();
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/copilot-auth/poll',
    async (attemptId: string): Promise<CopilotAuthPollResponse> => {
      return copilotBridge.pollLogin(String(attemptId ?? ''));
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/copilot-auth/cancel',
    async (attemptId: string): Promise<CopilotAuthCancelResponse> => {
      return copilotBridge.cancelLogin(String(attemptId ?? ''));
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/copilot-auth/logout',
    async (): Promise<CopilotAuthLogoutResponse> => {
      return copilotBridge.logout();
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/copilot-auth/status',
    async (): Promise<CopilotAuthStatusResponse> => {
      return copilotBridge.getConsoleStatus({ probe: true });
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/codex-auth/status',
    async (): Promise<CodexAuthStatusResponse> => {
      return codexBridge.getConsoleStatus({ probe: true });
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/codex-auth/start',
    async (): Promise<CodexAuthStartResponse> => {
      return codexBridge.startLogin();
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/codex-auth/poll',
    async (attemptId: string): Promise<CodexAuthPollResponse> => {
      return codexBridge.pollLogin(String(attemptId ?? ''));
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/codex-auth/cancel',
    async (attemptId: string): Promise<CodexAuthCancelResponse> => {
      return codexBridge.cancelLogin(String(attemptId ?? ''));
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/codex-auth/logout',
    async (): Promise<CodexAuthLogoutResponse> => {
      return codexBridge.logout();
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/save-feature-overrides',
    async (payload: SaveFeatureOverridesRequest): Promise<SaveFeatureOverridesResponse> => {
      if (!runtimeCtx.featurePolicy?.saveFeatureOverrides) {
        throw new Error('feature policy service unavailable');
      }
      const record = ensureRecord(payload);
      const overrides = Array.isArray(record.overrides) ? (record.overrides as SaveFeatureOverridesRequest['overrides']) : [];
      const nextOverrides = await runtimeCtx.featurePolicy.saveFeatureOverrides(overrides);
      return { overrides: nextOverrides };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/affinity/save-settings',
    async (payload: SaveAffinitySettingsRequest): Promise<SaveAffinitySettingsResponse> => {
      if (!runtimeCtx.affinity?.saveSettings) {
        throw new Error('affinity service unavailable');
      }
      const record = ensureRecord(payload);
      const settings = record.settings && typeof record.settings === 'object' && !Array.isArray(record.settings)
        ? record.settings as SaveAffinitySettingsRequest['settings']
        : {};
      return {
        ok: true,
        affinity: await runtimeCtx.affinity.saveSettings(settings),
      };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/affinity/save-whitelist',
    async (payload: SaveAffinityWhitelistRequest): Promise<SaveAffinityWhitelistResponse> => {
      if (!runtimeCtx.affinity?.saveWhitelist) {
        throw new Error('affinity service unavailable');
      }
      const record = ensureRecord(payload);
      const scopes = Array.isArray(record.scopes) ? record.scopes as SaveAffinityWhitelistRequest['scopes'] : [];
      return {
        ok: true,
        affinity: await runtimeCtx.affinity.saveWhitelist(scopes),
      };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/affinity/adjust-user',
    async (payload: AdjustAffinityUserRequest): Promise<AdjustAffinityUserResponse> => {
      if (!runtimeCtx.affinity?.adjustUserState) {
        throw new Error('affinity service unavailable');
      }
      const record = ensureRecord(payload);
      return {
        ok: true,
        affinity: await runtimeCtx.affinity.adjustUserState({
          userKey: String(record.userKey ?? ''),
          reason: String(record.reason ?? ''),
          trust: record.trust == null ? undefined : Number(record.trust),
          familiarity: record.familiarity == null ? undefined : Number(record.familiarity),
          comfort: record.comfort == null ? undefined : Number(record.comfort),
          tension: record.tension == null ? undefined : Number(record.tension),
        }),
      };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/get-tool-policy-state',
    async () => {
      if (runtimeCtx.toolPolicy?.getToolPolicyState) {
        return runtimeCtx.toolPolicy.getToolPolicyState();
      }
      const conversationTargets = runtimeCtx.featurePolicy?.listConversationTargets
        ? await runtimeCtx.featurePolicy.listConversationTargets()
        : [];
      return {
        catalog: [],
        routeProfiles: [],
        routeProfileInfo: [],
        defaultScopes: [],
        scopes: [],
        overrides: [],
        conversationTargets,
      };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/save-tool-overrides',
    async (payload: SaveToolOverridesRequest): Promise<SaveToolOverridesResponse> => {
      if (!runtimeCtx.toolPolicy?.saveToolOverrides) {
        throw new Error('tool policy service unavailable');
      }
      const record = ensureRecord(payload);
      const overrides = Array.isArray(record.overrides) ? (record.overrides as SaveToolOverridesRequest['overrides']) : [];
      const nextOverrides = await runtimeCtx.toolPolicy.saveToolOverrides(overrides);
      return { overrides: nextOverrides };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/clear-conversation-history',
    async (payload: ClearConversationHistoryRequest): Promise<ClearConversationHistoryResponse> => {
      if (!runtimeCtx.featurePolicy?.clearConversationHistory) {
        throw new Error('feature policy service unavailable');
      }
      const record = ensureRecord(payload);
      const result = await runtimeCtx.featurePolicy.clearConversationHistory({
        roomId: Number(record.roomId ?? 0),
        conversationId: String(record.conversationId ?? ''),
      });
      return { result };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/delete-conversation-room',
    async (payload: DeleteConversationRoomRequest): Promise<DeleteConversationRoomResponse> => {
      if (!runtimeCtx.featurePolicy?.deleteConversationRoom) {
        throw new Error('feature policy service unavailable');
      }
      const record = ensureRecord(payload);
      const result = await runtimeCtx.featurePolicy.deleteConversationRoom({
        roomId: Number(record.roomId ?? 0),
        conversationId: String(record.conversationId ?? ''),
      });
      return { result };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/save-preset',
    async (payload: unknown) => {
      const preset = await manager.savePreset(ensureRecord(payload) as unknown as PresetDocument);
      return { preset, restartRequired: true };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/delete-preset',
    async (name: string, defaultPreset: string) => {
      await manager.deletePreset(String(name ?? ''), String(defaultPreset ?? ''));
      return { ok: true, restartRequired: true };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/reorder-presets',
    async (payload: unknown): Promise<ReorderPresetsResponse> => {
      const record = ensureRecord(payload);
      const names = Array.isArray(record.names) ? record.names.map((item) => String(item ?? '')) : [];
      const presets = await manager.reorderPresets(names);
      return { presets };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/service-action',
    async (unit: BotServiceUnit, action: ServiceAction) => {
      const status = await manager.runServiceAction(unit, action);
      return { status };
    },
    { authority: LISTENER_AUTHORITY },
  );

  if (ctx.server) {
    ctx.server.get('/api/internal/copilot/v1/models', async (koaCtx: any) => {
      if (!(await validateCopilotBridgeAuth(koaCtx, copilotBridge))) return;
      const result = await copilotBridge.proxyModels();
      koaCtx.status = result.status;
      for (const [key, value] of Object.entries(result.headers)) {
        koaCtx.set(key, value);
      }
      koaCtx.body = result.body;
    });

    ctx.server.post('/api/internal/copilot/v1/responses', async (koaCtx: any) => {
      if (!(await validateCopilotBridgeAuth(koaCtx, copilotBridge))) return;
      const result = await copilotBridge.proxyResponses(koaCtx.request.body);
      koaCtx.status = result.status;
      for (const [key, value] of Object.entries(result.headers)) {
        koaCtx.set(key, value);
      }
      koaCtx.body = result.body;
    });

    ctx.server.post('/api/internal/copilot/v1/chat/completions', async (koaCtx: any) => {
      if (!(await validateCopilotBridgeAuth(koaCtx, copilotBridge))) return;
      const result = await copilotBridge.proxyChatCompletions(koaCtx.request.body);
      koaCtx.status = result.status;
      for (const [key, value] of Object.entries(result.headers)) {
        koaCtx.set(key, value);
      }
      koaCtx.body = result.body;
    });

    ctx.server.get('/api/internal/codex/v1/models', async (koaCtx: any) => {
      if (!(await validateCodexBridgeAuth(koaCtx, codexBridge))) return;
      const result = await codexBridge.proxyModels();
      koaCtx.status = result.status;
      for (const [key, value] of Object.entries(result.headers)) {
        koaCtx.set(key, value);
      }
      koaCtx.body = result.body;
    });

    ctx.server.post('/api/internal/codex/v1/responses', async (koaCtx: any) => {
      if (!(await validateCodexBridgeAuth(koaCtx, codexBridge))) return;
      const result = await codexBridge.proxyResponses(koaCtx.request.body);
      koaCtx.status = result.status;
      for (const [key, value] of Object.entries(result.headers)) {
        koaCtx.set(key, value);
      }
      koaCtx.body = result.body;
    });

    ctx.server.options('/api/internal/qq-voice/v1/send', async (koaCtx: any) => {
      setQqVoiceBridgeCorsHeaders(koaCtx);
      koaCtx.status = 204;
    });

    ctx.server.options('/api/internal/affinity/v1/random-plans', async (koaCtx: any) => {
      setQqVoiceBridgeCorsHeaders(koaCtx);
      koaCtx.status = 204;
    });

    ctx.server.post('/api/internal/qq-voice/v1/send', async (koaCtx: any) => {
      setQqVoiceBridgeCorsHeaders(koaCtx);
      if (!validateVoiceBridgeAuthHeader(String(koaCtx.get('authorization') || ''))) {
        writeJsonError(koaCtx, 401, 'invalid_request_error', 'invalid qq voice bridge authorization');
        return;
      }

      try {
        const request = parseQqVoiceBridgeRequest(koaCtx.request.body);
        const response = await sendVoiceByBridge(ctx, request);
        koaCtx.status = 200;
        koaCtx.set('content-type', 'application/json; charset=utf-8');
        koaCtx.body = JSON.stringify(response);
      } catch (error) {
        if (error instanceof QqVoiceBridgeHttpError) {
          writeJsonError(koaCtx, error.status, error.code, error.message);
          return;
        }
        logger.warn('qq voice bridge failed: %s', error instanceof Error ? error.message : String(error));
        writeJsonError(koaCtx, 500, 'internal_error', 'qq voice bridge failed');
      }
    });

    ctx.server.post('/api/internal/affinity/v1/random-plans', async (koaCtx: any) => {
      setQqVoiceBridgeCorsHeaders(koaCtx);
      if (!validateVoiceBridgeAuthHeader(String(koaCtx.get('authorization') || ''))) {
        writeJsonError(koaCtx, 401, 'invalid_request_error', 'invalid affinity bridge authorization');
        return;
      }
      if (!runtimeCtx.affinity?.createManualRandomPlan) {
        writeJsonError(koaCtx, 503, 'affinity_unavailable', 'affinity service is unavailable');
        return;
      }

      try {
        const request = parseAffinityRandomPlanBridgeRequest(koaCtx.request.body);
        const response = await runtimeCtx.affinity.createManualRandomPlan(request);
        koaCtx.status = 200;
        koaCtx.set('content-type', 'application/json; charset=utf-8');
        koaCtx.body = JSON.stringify(response);
      } catch (error) {
        if (error instanceof AffinityBridgeHttpError) {
          writeJsonError(koaCtx, error.status, error.code, error.message);
          return;
        }
        if (error instanceof Error && error.message === 'affinity is disabled') {
          writeJsonError(koaCtx, 503, 'affinity_disabled', error.message);
          return;
        }
        logger.warn('affinity bridge failed: %s', error instanceof Error ? error.message : String(error));
        writeJsonError(koaCtx, 500, 'internal_error', 'affinity bridge failed');
      }
    });
  }

  logger.info('bot console extension registered.');
}

async function validateCopilotBridgeAuth(koaCtx: any, bridge: CopilotOAuthBridgeService): Promise<boolean> {
  const expected = await bridge.getRuntimeConfig();
  const authHeader = String(koaCtx.get('authorization') || '').trim();
  if (authHeader === `Bearer ${expected.apiKey}`) {
    return true;
  }
  writeJsonError(koaCtx, 401, 'invalid_request_error', 'invalid copilot bridge authorization');
  return false;
}

async function validateCodexBridgeAuth(koaCtx: any, bridge: CodexOAuthBridgeService): Promise<boolean> {
  const expected = await bridge.getRuntimeConfig();
  const authHeader = String(koaCtx.get('authorization') || '').trim();
  if (authHeader === `Bearer ${expected.apiKey}`) {
    return true;
  }
  writeJsonError(koaCtx, 401, 'invalid_request_error', 'invalid codex bridge authorization');
  return false;
}

function writeJsonError(koaCtx: any, status: number, type: string, message: string): void {
  koaCtx.status = status;
  koaCtx.set('content-type', 'application/json; charset=utf-8');
  koaCtx.body = JSON.stringify({
    error: {
      message,
      type,
    },
  });
}

function setQqVoiceBridgeCorsHeaders(koaCtx: any): void {
  koaCtx.set('access-control-allow-origin', '*');
  koaCtx.set('access-control-allow-methods', 'POST, OPTIONS');
  koaCtx.set('access-control-allow-headers', 'authorization, content-type');
  koaCtx.set('access-control-max-age', '600');
}
