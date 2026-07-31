import { Context, Logger, type Session } from 'koishi';
import type { ConversationTarget, FeaturePolicyServiceLike } from '../../types/feature-policy.js';
import type {
  AdminToolPolicyState,
  ResolveAllowedToolsOptions,
  ResolveAllowedToolsResult,
  ToolCatalogEntry,
  ToolMask,
  ToolOverrideInput,
  ToolOverrideRecord,
  ToolPolicyScope,
  ToolPolicyServiceLike,
  ToolRouteProfile,
  ToolScopeKind,
} from '../../types/tool-policy.js';
import {
  GLOBAL_DEFAULT_SCOPE_ID,
  LEGACY_TOOL_NAME_ALIASES,
  PRIVATE_DEFAULT_SCOPE_ID,
  TOOL_CATALOG,
  TOOL_CATALOG_MAP,
  TOOL_DEFAULT_SCOPES,
  TOOL_ROUTE_PROFILES,
} from '../shared/tool-policy-catalog.js';
import { normalizeReplyChatMode } from '../shared/reply-chat-mode.js';
import { normalizeGroupId, parseGroupSet } from '../shared/group-id.js';

export const name = 'tool-policy';
export const inject = { required: ['database', 'chatluna', 'featurePolicy'] } as const;

const logger = new Logger(name);
const FILE_SYSTEM_GROUP_RESTRICTED_TOOLS = new Set([
  'bash',
  'file_edit',
  'file_publish',
  'file_read',
  'file_write',
  'glob',
  'grep',
]);
const FILE_SYSTEM_ALLOWED_GROUPS_ENV = 'CHATLUNA_COMMON_FS_ALLOWED_GROUPS';

type DatabaseLike = {
  get(table: string, query: Record<string, unknown>): Promise<any[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
};

type ChatLunaLike = {
  registerToolMaskResolver?: (
    name: string,
    resolver: (arg: ToolMaskArg) => Promise<ToolMask | undefined> | ToolMask | undefined,
  ) => () => void;
  platform?: {
    getToolRegistry?: () => Record<string, { name: string; description?: string; meta?: Record<string, unknown> }>;
  };
};

type RoomLike = ResolveAllowedToolsOptions['room'] & {
  groupId?: string | null;
};

type ServiceContext = {
  database?: DatabaseLike;
  chatluna?: ChatLunaLike;
  featurePolicy?: FeaturePolicyServiceLike;
  get?: (name: string) => unknown;
  provide?: (name: string) => void;
  set?: (name: string, value: unknown) => void;
  toolPolicy?: ToolPolicyServiceLike;
  model?: { extend?: (...args: any[]) => unknown };
  on?: (event: string, listener: () => void) => void;
};

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function toPositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.floor(parsed);
}

function nowTimestamp(): number {
  return Date.now();
}

function isToolRouteProfile(value: string): value is ToolRouteProfile {
  return value === 'agent' || value === 'automation';
}

function isToolScopeKind(value: string): value is ToolScopeKind {
  return value === 'global_default' ||
    value === 'private_default' ||
    value === 'private_conversation' ||
    value === 'group';
}

function createAllowMask(allow: string[]): ToolMask {
  return {
    mode: 'allow',
    allow: [...allow],
    deny: [],
    toolCallMask: {
      mode: 'allow',
      allow: [...allow],
      deny: [],
    },
  };
}

function normalizeOverrideInput(input: ToolOverrideInput): ToolOverrideInput {
  const toolName = normalizeText(input.toolName);
  const routeProfile = normalizeText(input.routeProfile);
  const scopeKind = normalizeText(input.scopeKind);
  const scopeId = normalizeText(input.scopeId);

  if (!toolName) throw new Error('工具标识不能为空。');
  if (!isToolRouteProfile(routeProfile)) {
    throw new Error(`不支持这个链路类型：${routeProfile}`);
  }
  if (!isToolScopeKind(scopeKind)) {
    throw new Error(`不支持这个作用域类型：${scopeKind}`);
  }
  if (!scopeId) {
    throw new Error('作用域标识不能为空。');
  }
  if (scopeKind === 'global_default' && scopeId !== GLOBAL_DEFAULT_SCOPE_ID) {
    throw new Error('全局默认作用域标识不正确。');
  }
  if (scopeKind === 'private_default' && scopeId !== PRIVATE_DEFAULT_SCOPE_ID) {
    throw new Error('私聊默认作用域标识不正确。');
  }

  return {
    toolName,
    routeProfile,
    scopeKind,
    scopeId,
    enabled: Boolean(input.enabled),
  };
}

function buildOverrideKey(
  toolName: string,
  routeProfile: ToolRouteProfile,
  scopeKind: ToolScopeKind,
  scopeId: string,
): string {
  return `${toolName}:${routeProfile}:${scopeKind}:${scopeId}`;
}

export class ToolPolicyService implements ToolPolicyServiceLike {
  private overrideCache = new Map<string, ToolOverrideRecord>();
  private cacheLoaded = false;
  private lastUnknownRegistrySignature = '';

  constructor(
    private readonly database: DatabaseLike,
    private readonly featurePolicy: FeaturePolicyServiceLike,
    private readonly resolveChatLuna?: () => ChatLunaLike | undefined,
    private readonly fileSystemAllowedGroupIds = parseGroupSet(process.env[FILE_SYSTEM_ALLOWED_GROUPS_ENV]),
  ) {}

  async getToolPolicyState(): Promise<AdminToolPolicyState> {
    const conversationTargets = await this.listConversationTargets();
    const runtimeTools = new Set(this.getRuntimeToolNames());
    return {
      routeProfiles: TOOL_ROUTE_PROFILES.map((entry) => entry.id),
      catalog: TOOL_CATALOG.map((entry) => ({ ...entry, registered: runtimeTools.has(entry.toolName) })),
      routeProfileInfo: TOOL_ROUTE_PROFILES.map((entry) => ({ ...entry })),
      defaultScopes: TOOL_DEFAULT_SCOPES.map((entry) => ({ ...entry })),
      scopes: this.buildScopes(conversationTargets),
      overrides: await this.getToolOverrides(),
      conversationTargets,
    };
  }

  async getToolOverrides(): Promise<ToolOverrideRecord[]> {
    await this.ensureOverrideCache();
    return [...this.overrideCache.values()]
      .map((row) => ({ ...row }))
      .sort((left, right) => {
        const toolDelta = left.toolName.localeCompare(right.toolName, 'zh-CN');
        if (toolDelta !== 0) return toolDelta;
        const routeDelta = left.routeProfile.localeCompare(right.routeProfile, 'zh-CN');
        if (routeDelta !== 0) return routeDelta;
        const scopeDelta = `${left.scopeKind}:${left.scopeId}`.localeCompare(`${right.scopeKind}:${right.scopeId}`, 'zh-CN');
        if (scopeDelta !== 0) return scopeDelta;
        return left.id - right.id;
      });
  }

  async saveToolOverrides(overrides: ToolOverrideInput[]): Promise<ToolOverrideRecord[]> {
    await this.ensureOverrideCache();
    const normalized = overrides.map((item) => this.validateOverrideInput(item));
    this.validateDependencies(normalized);

    const desired = new Map<string, ToolOverrideInput>();
    for (const item of normalized) {
      desired.set(buildOverrideKey(item.toolName, item.routeProfile, item.scopeKind, item.scopeId), item);
    }

    const existing = [...this.overrideCache.values()];
    const existingByKey = new Map(
      existing.map((row) => [buildOverrideKey(row.toolName, row.routeProfile, row.scopeKind, row.scopeId), row]),
    );
    const timestamp = nowTimestamp();

    for (const row of existing) {
      const key = buildOverrideKey(row.toolName, row.routeProfile, row.scopeKind, row.scopeId);
      if (!desired.has(key)) {
        await this.database.remove('tool_scope_override', { id: row.id });
        this.overrideCache.delete(key);
      }
    }

    for (const item of desired.values()) {
      const key = buildOverrideKey(item.toolName, item.routeProfile, item.scopeKind, item.scopeId);
      const existingRow = existingByKey.get(key);
      const patch = {
        toolName: item.toolName,
        routeProfile: item.routeProfile,
        scopeKind: item.scopeKind,
        scopeId: item.scopeId,
        enabled: item.enabled ? 1 : 0,
        updatedAt: timestamp,
      };

      if (existingRow?.id) {
        await this.database.set('tool_scope_override', { id: existingRow.id }, patch);
        this.overrideCache.set(key, {
          ...existingRow,
          ...patch,
          id: existingRow.id,
        });
      } else {
        const created = (await this.database.create('tool_scope_override', patch)) as unknown as ToolOverrideRecord;
        this.overrideCache.set(key, {
          ...created,
          ...patch,
          id: Number(created.id),
        });
      }
    }

    return this.getToolOverrides();
  }

  async resolveAllowedTools(options: ResolveAllowedToolsOptions): Promise<ResolveAllowedToolsResult> {
    await this.ensureOverrideCache();
    const catalogMap = this.getRuntimeCatalogMap();

    const toolNames = Array.from(new Set(options.toolNames.map((name) => normalizeText(name)).filter(Boolean)));
    const unknown = toolNames.filter((name) => !catalogMap.has(name));
    const known = toolNames.filter((name) => catalogMap.has(name));
    const scopeIds = await this.resolveScopeIds(options.session, options.room ?? null);

    const allowed = known.filter((toolName) => {
      const tool = catalogMap.get(toolName);
      if (!tool) return false;
      if (tool.management === 'locked_off') return false;
      if (!tool.availableRoutes.includes(options.routeProfile)) return false;

      let enabled = tool.defaultEnabledByRoute[options.routeProfile];
      enabled = this.resolveOverrideEnabled(toolName, options.routeProfile, 'global_default', GLOBAL_DEFAULT_SCOPE_ID, enabled);

      if (options.session.isDirect) {
        enabled = this.resolveOverrideEnabled(toolName, options.routeProfile, 'private_default', PRIVATE_DEFAULT_SCOPE_ID, enabled);
        if (scopeIds.privateConversationScopeId) {
          enabled = this.resolveOverrideEnabled(
            toolName,
            options.routeProfile,
            'private_conversation',
            scopeIds.privateConversationScopeId,
            enabled,
          );
        }
      } else if (scopeIds.groupScopeId) {
        enabled = this.resolveOverrideEnabled(toolName, options.routeProfile, 'group', scopeIds.groupScopeId, enabled);
      }

      return enabled;
    });

    return {
      allowed: this.filterGroupRestrictedTools(allowed, options.session, scopeIds.groupScopeId),
      unknown,
    };
  }

  async resolveToolMask(
    session: Session,
    routeProfile: ToolRouteProfile,
    room?: ResolveAllowedToolsOptions['room'],
  ): Promise<ToolMask> {
    this.logUnknownRegisteredTools();
    const registeredNames = this.getRuntimeToolNames();
    const { allowed } = await this.resolveAllowedTools({
      session,
      routeProfile,
      toolNames: registeredNames,
      room: room ?? null,
    });
    return createAllowMask(allowed);
  }

  private async ensureOverrideCache(): Promise<void> {
    if (this.cacheLoaded) return;
    const rows = (await this.database.get('tool_scope_override', {} as Record<string, never>)) as ToolOverrideRecord[];
    const catalogMap = this.getRuntimeCatalogMap();
    const candidates: Array<{ normalized: ToolOverrideRecord; shouldUpdate: boolean }> = [];
    const staleIds = new Set<number>();

    for (const row of rows) {
      const normalized = this.normalizePersistedOverride(row);
      if (!normalized || !catalogMap.has(normalized.normalized.toolName)) {
        staleIds.add(Number(row.id));
        continue;
      }

      candidates.push(normalized);
    }

    const winners = new Map<string, { normalized: ToolOverrideRecord; shouldUpdate: boolean }>();
    for (const candidate of candidates) {
      const key = buildOverrideKey(
        candidate.normalized.toolName,
        candidate.normalized.routeProfile,
        candidate.normalized.scopeKind,
        candidate.normalized.scopeId,
      );
      const current = winners.get(key);
      if (!current || this.isPreferredOverride(candidate.normalized, current.normalized)) {
        if (current) staleIds.add(current.normalized.id);
        winners.set(key, candidate);
      } else {
        staleIds.add(candidate.normalized.id);
      }
    }

    if (staleIds.size > 0) {
      await this.database.remove('tool_scope_override', { id: [...staleIds] });
    }

    this.overrideCache.clear();
    for (const row of winners.values()) {
      if (row.shouldUpdate) {
        await this.database.set('tool_scope_override', { id: row.normalized.id }, {
          toolName: row.normalized.toolName,
          routeProfile: row.normalized.routeProfile,
          scopeKind: row.normalized.scopeKind,
          scopeId: row.normalized.scopeId,
          enabled: row.normalized.enabled,
          updatedAt: row.normalized.updatedAt,
        });
      }

      this.overrideCache.set(
        buildOverrideKey(
          row.normalized.toolName,
          row.normalized.routeProfile,
          row.normalized.scopeKind,
          row.normalized.scopeId,
        ),
        { ...row.normalized },
      );
    }
    this.cacheLoaded = true;
  }

  private resolveOverrideEnabled(
    toolName: string,
    routeProfile: ToolRouteProfile,
    scopeKind: ToolScopeKind,
    scopeId: string,
    fallback: boolean,
  ): boolean {
    const override = this.overrideCache.get(buildOverrideKey(toolName, routeProfile, scopeKind, scopeId));
    if (!override) return fallback;
    return Number(override.enabled ?? 0) === 1;
  }

  private async resolveScopeIds(session: Session, room: ResolveAllowedToolsOptions['room']) {
    const groupScopeId = session.isDirect
      ? null
      : normalizeGroupId(normalizeText(session.guildId)) ?? normalizeGroupId(normalizeText(session.channelId)) ?? null;

    let privateConversationScopeId: string | null = null;
    if (session.isDirect) {
      const roomId = toPositiveInteger(room?.roomId);
      if (roomId != null) {
        privateConversationScopeId = String(roomId);
      } else {
        const target = await this.featurePolicy.resolvePrivateConversationTarget(session);
        privateConversationScopeId = target?.scopeId ?? null;
      }
    }

    return { groupScopeId, privateConversationScopeId };
  }

  private filterGroupRestrictedTools(toolNames: string[], session: Session, groupScopeId: string | null): string[] {
    if (session.isDirect) return toolNames;
    if (groupScopeId && this.fileSystemAllowedGroupIds.has(groupScopeId)) return toolNames;
    return toolNames.filter((toolName) => !FILE_SYSTEM_GROUP_RESTRICTED_TOOLS.has(toolName));
  }

  private validateDependencies(overrides: ToolOverrideInput[]): void {
    const desired = new Map<string, boolean>();
    const catalog = this.getRuntimeCatalog();
    const catalogMap = new Map(catalog.map((tool) => [tool.toolName, tool]));
    for (const tool of catalog) {
      for (const routeProfile of ['agent', 'automation'] as const) {
        desired.set(
          `${tool.toolName}:${routeProfile}:global_default:${GLOBAL_DEFAULT_SCOPE_ID}`,
          tool.defaultEnabledByRoute[routeProfile],
        );
        desired.set(
          `${tool.toolName}:${routeProfile}:private_default:${PRIVATE_DEFAULT_SCOPE_ID}`,
          tool.defaultEnabledByRoute[routeProfile],
        );
      }
    }

    for (const item of overrides) {
      desired.set(`${item.toolName}:${item.routeProfile}:${item.scopeKind}:${item.scopeId}`, item.enabled);
    }

    for (const item of overrides) {
      const tool = catalogMap.get(item.toolName);
      if (!tool || tool.hardDependencies.length === 0 || !item.enabled) continue;
      for (const dependency of tool.hardDependencies) {
        if (desired.get(`${dependency}:${item.routeProfile}:${item.scopeKind}:${item.scopeId}`) === false) {
          throw new Error(`工具 ${item.toolName} 依赖 ${dependency}，不能在同一作用域下单独启用。`);
        }
      }
    }
  }

  private async listConversationTargets(): Promise<ConversationTarget[]> {
    const targets = await this.featurePolicy.listConversationTargets();
    return targets.map((target) => ({ ...target }));
  }

  private buildScopes(conversationTargets: ConversationTarget[]): ToolPolicyScope[] {
    const scopes: ToolPolicyScope[] = [
      {
        scopeKind: 'global_default',
        scopeId: GLOBAL_DEFAULT_SCOPE_ID,
        roomId: null,
        roomName: '全局默认',
        groupId: null,
        conversationId: null,
        visibility: null,
        updatedAt: null,
      },
      {
        scopeKind: 'private_default',
        scopeId: PRIVATE_DEFAULT_SCOPE_ID,
        roomId: null,
        roomName: '所有私聊',
        groupId: null,
        conversationId: null,
        visibility: 'private',
        updatedAt: null,
      },
    ];

    for (const target of conversationTargets) {
      if (target.scopeKind === 'group') {
        scopes.push({
          scopeKind: 'group',
          scopeId: target.scopeId,
          roomId: target.roomId,
          roomName: target.roomName,
          groupId: target.groupId,
          conversationId: target.conversationId,
          visibility: 'group',
          updatedAt: target.updatedAt,
        });
        continue;
      }

      scopes.push({
        scopeKind: 'private_conversation',
        scopeId: String(target.roomId),
        roomId: target.roomId,
        roomName: target.roomName,
        groupId: null,
        conversationId: target.conversationId,
        visibility: 'private',
        updatedAt: target.updatedAt,
      });
    }

    return scopes;
  }

  private logUnknownRegisteredTools(): void {
    const registered = this.getRuntimeToolNames();
    if (!registered.length) return;
    const unknown = registered.filter((name) => !TOOL_CATALOG_MAP.has(name)).sort((left, right) => left.localeCompare(right, 'zh-CN'));
    const signature = unknown.join('|');
    if (!unknown.length || signature === this.lastUnknownRegistrySignature) return;
    this.lastUnknownRegistrySignature = signature;
    logger.warn('tool-policy unknown tools will be filtered by default: %s', unknown.join(', '));
  }

  private validateOverrideInput(input: ToolOverrideInput): ToolOverrideInput {
    const normalized = normalizeOverrideInput(input);
    const tool = this.getRuntimeCatalogMap().get(normalized.toolName);
    if (!tool) {
      throw new Error(`不支持这个工具：${normalized.toolName}`);
    }
    if (normalized.enabled && tool.management === 'locked_off') {
      throw new Error(tool.managementNote ?? `工具 ${normalized.toolName} 已锁定为关闭。`);
    }
    return normalized;
  }

  private getRuntimeToolRegistry() {
    const registry = this.resolveChatLuna?.()?.platform?.getToolRegistry?.();
    if (!registry) {
      throw new Error('chatluna runtime tool registry is unavailable.');
    }
    return registry;
  }

  private getRuntimeToolNames(): string[] {
    return Object.keys(this.getRuntimeToolRegistry()).sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }

  private getRuntimeCatalog(): ToolCatalogEntry[] {
    const runtimeTools = new Set(this.getRuntimeToolNames());
    return TOOL_CATALOG.filter((entry) => runtimeTools.has(entry.toolName));
  }

  private getRuntimeCatalogMap(): Map<string, ToolCatalogEntry> {
    return new Map(this.getRuntimeCatalog().map((entry) => [entry.toolName, entry]));
  }

  private normalizePersistedOverride(row: ToolOverrideRecord): { normalized: ToolOverrideRecord; shouldUpdate: boolean } | null {
    const originalToolName = normalizeText(row.toolName);
    const aliasedToolName = Object.prototype.hasOwnProperty.call(LEGACY_TOOL_NAME_ALIASES, originalToolName)
      ? LEGACY_TOOL_NAME_ALIASES[originalToolName]
      : originalToolName;
    const routeProfile = normalizeText(row.routeProfile);
    const scopeKind = normalizeText(row.scopeKind);
    const scopeId = normalizeText(row.scopeId);
    const enabled = Number(row.enabled ?? 0) === 1 ? 1 : 0;
    const updatedAt = Number(row.updatedAt ?? 0);

    if (
      aliasedToolName == null ||
      !aliasedToolName ||
      !isToolRouteProfile(routeProfile) ||
      !isToolScopeKind(scopeKind) ||
      !scopeId
    ) {
      return null;
    }

    return {
      normalized: {
        ...row,
        id: Number(row.id),
        toolName: aliasedToolName,
        routeProfile,
        scopeKind,
        scopeId,
        enabled,
        updatedAt,
      },
      shouldUpdate:
        aliasedToolName !== originalToolName ||
        routeProfile !== row.routeProfile ||
        scopeKind !== row.scopeKind ||
        scopeId !== row.scopeId ||
        enabled !== Number(row.enabled ?? 0) ||
        updatedAt !== Number(row.updatedAt ?? 0),
    };
  }

  private isPreferredOverride(left: ToolOverrideRecord, right: ToolOverrideRecord): boolean {
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt > right.updatedAt;
    }
    return left.id > right.id;
  }
}

function resolveChatLunaService(ctx: ServiceContext): ChatLunaLike | undefined {
  const getter = ctx.get;
  if (typeof getter === 'function') {
    const service = getter.call(ctx, 'chatluna');
    if (service) return service as ChatLunaLike;
  }
  return ctx.chatluna;
}

export function apply(ctx: Context): void {
  const serviceCtx = ctx as unknown as ServiceContext;
  const database = serviceCtx.database;
  if (!database) {
    throw new Error('tool-policy requires database service.');
  }
  const featurePolicy = serviceCtx.featurePolicy;
  if (!featurePolicy) {
    throw new Error('tool-policy requires featurePolicy service.');
  }

  if (typeof serviceCtx.model?.extend === 'function') {
    serviceCtx.model.extend(
      'tool_scope_override',
      {
        id: 'unsigned',
        toolName: 'string',
        routeProfile: 'string',
        scopeKind: 'string',
        scopeId: 'string',
        enabled: 'unsigned',
        updatedAt: 'double',
      },
      {
        autoInc: true,
        indexes: [['toolName', 'routeProfile', 'scopeKind', 'scopeId'], ['routeProfile', 'scopeKind', 'scopeId']],
      },
    );
  }

  const service = new ToolPolicyService(database, featurePolicy, () => resolveChatLunaService(serviceCtx));
  if (typeof serviceCtx.provide === 'function' && typeof serviceCtx.set === 'function') {
    serviceCtx.provide('toolPolicy');
    serviceCtx.set('toolPolicy', service);
  } else {
    serviceCtx.toolPolicy = service;
  }

  let disposeToolMaskResolver: (() => void) | null = null;
  const registerToolMaskResolver = (): void => {
    if (disposeToolMaskResolver) return;
    const chatluna = resolveChatLunaService(serviceCtx);
    const registerResolver = chatluna?.registerToolMaskResolver?.bind(chatluna);
    const getToolRegistry = chatluna?.platform?.getToolRegistry?.bind(chatluna.platform);
    if (typeof registerResolver !== 'function' || typeof getToolRegistry !== 'function') {
      throw new Error('tool-policy requires chatluna registerToolMaskResolver and runtime tool registry during startup.');
    }
    getToolRegistry();
    disposeToolMaskResolver = registerResolver(name, async ({ session, conversation }: ToolMaskArg) => {
      const resolvedRoom = conversation
        ? ({
            roomId: conversation.legacyRoomId,
            conversationId: conversation.id,
            chatMode: conversation.chatMode,
          } satisfies RoomLike)
        : null;
      const normalizedChatMode = normalizeReplyChatMode(resolvedRoom?.chatMode);
      const routeProfile =
        normalizedChatMode === 'automation'
          ? 'automation'
          : 'agent';
      return service.resolveToolMask(session, routeProfile, resolvedRoom);
    });
  };

  ctx.on('ready', () => {
    registerToolMaskResolver();
  });

  ctx.on('dispose', () => {
    if (disposeToolMaskResolver) {
      disposeToolMaskResolver();
      disposeToolMaskResolver = null;
    }
  });
}
type ToolMaskArg = {
  session: Session;
  conversation?: {
    id: string;
    legacyRoomId?: number | null;
    chatMode: string;
  };
};
