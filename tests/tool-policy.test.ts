import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  type MockSchemaNode = {
    description: () => MockSchemaNode;
    role: () => MockSchemaNode;
  };
  const createSchemaNode = (): MockSchemaNode => ({
    description: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });
  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      boolean: createSchemaNode,
      natural: createSchemaNode,
      object: createSchemaNode,
      string: createSchemaNode,
    },
    h: {},
  };
});

import { apply, inject } from '../src/plugins/tool-policy/index.js';
import {
  AFFINITY_PROACTIVE_TOOL_MASK_POLICY,
  createAffinityProactiveToolMask,
} from '../src/plugins/affinity/proactive-tool-mask.js';
import { GLOBAL_DEFAULT_SCOPE_ID, PRIVATE_DEFAULT_SCOPE_ID, TOOL_CATALOG } from '../src/plugins/shared/tool-policy-catalog.js';
import { QQBOT_SUBMIT_REPLY_TOOL_NAME } from '../src/plugins/shared/internal-tool-names.js';
import type { ToolCatalogEntry } from '../src/types/tool-policy.js';

type Row = Record<string, any>;

function matches(row: Row, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value);
}

function createDatabase(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]),
  );
  let nextId = 1;

  const ensure = (table: string): Row[] => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };

  return {
    async get(table: string, query: Record<string, unknown>) {
      const rows = ensure(table);
      if (!query || Object.keys(query).length === 0) return rows.map((row) => ({ ...row }));
      return rows.filter((row) => matches(row, query)).map((row) => ({ ...row }));
    },
    async set(table: string, query: Record<string, unknown>, data: Record<string, unknown>) {
      const rows = ensure(table);
      for (const row of rows) {
        if (matches(row, query)) Object.assign(row, data);
      }
    },
    async create(table: string, row: Record<string, unknown>) {
      const rows = ensure(table);
      const next = { ...row } as Row;
      if (table === 'tool_scope_override' && next.id == null) {
        next.id = nextId++;
      }
      rows.push(next);
      return { ...next };
    },
    async remove(table: string, query: Record<string, unknown>) {
      const rows = ensure(table);
      tables.set(table, rows.filter((row) => !matches(row, query)));
    },
  };
}

function createHarness(
  seed: Record<string, Row[]> = {},
  options: {
    initialChatLunaAvailable?: boolean;
    fileToolAllowedGroups?: string | null;
  } = {},
) {
  const database = createDatabase(seed);
  const extend = vi.fn();
  const readyHandlers: Array<() => void> = [];
  const toolRegistry: Record<string, { name: string; description?: string; meta?: Record<string, unknown> }> = {
    file_read: { name: 'file_read' },
    file_write: { name: 'file_write' },
    file_edit: { name: 'file_edit' },
    file_publish: { name: 'file_publish' },
    grep: { name: 'grep' },
    glob: { name: 'glob' },
    bash: { name: 'bash' },
    web_run: { name: 'web_run' },
    question: { name: 'question' },
    task: { name: 'task' },
    hbu_jw_course_guidance_context: { name: 'hbu_jw_course_guidance_context' },
    cf_user_profile: { name: 'cf_user_profile' },
    unknown_runtime_tool: { name: 'unknown_runtime_tool' },
  };
  const registerToolMaskResolver = vi.fn(function (this: any, name: string, resolver: unknown) {
    if (!this || this !== chatluna) {
      throw new Error('registerToolMaskResolver lost chatluna binding');
    }
    return () => {};
  });
  const chatluna = {
    registerToolMaskResolver,
    platform: {
      getToolRegistry: () => toolRegistry,
      registerTool: vi.fn((name: string, tool: any) => {
        toolRegistry[name] = tool;
        return () => {
          delete toolRegistry[name];
        };
      }),
    },
  };
  let currentChatLuna: typeof chatluna | undefined = options.initialChatLunaAvailable === false ? undefined : chatluna;

  const ctx: any = {
    database,
    model: { extend },
    featurePolicy: {
      listConversationTargets: vi.fn().mockResolvedValue([
        {
          roomId: 7,
          roomName: '私聊房间 #7',
          scopeKind: 'private',
          scopeId: '7',
          groupId: null,
          conversationId: 'conv-private',
          updatedAt: 1,
        },
      ]),
      resolvePrivateConversationTarget: vi.fn().mockResolvedValue({
        roomId: 7,
        roomName: '私聊房间 #7',
        scopeKind: 'private',
        scopeId: '7',
        groupId: null,
        conversationId: 'conv-private',
        updatedAt: 1,
      }),
    },
    chatluna: currentChatLuna,
    get(name: string) {
      if (name === 'chatluna') return currentChatLuna;
      return undefined;
    },
    on(event: string, handler: () => void) {
      if (event === 'ready') readyHandlers.push(handler);
    },
    toolPolicy: undefined,
  };

  const previousFileToolAllowedGroups = process.env.CHATLUNA_COMMON_FS_ALLOWED_GROUPS;
  const hasFileToolAllowedGroupsOverride = Object.prototype.hasOwnProperty.call(options, 'fileToolAllowedGroups');
  if (hasFileToolAllowedGroupsOverride) {
    if (options.fileToolAllowedGroups == null) {
      delete process.env.CHATLUNA_COMMON_FS_ALLOWED_GROUPS;
    } else {
      process.env.CHATLUNA_COMMON_FS_ALLOWED_GROUPS = options.fileToolAllowedGroups;
    }
  }

  try {
    apply(ctx);
  } finally {
    if (hasFileToolAllowedGroupsOverride) {
      if (previousFileToolAllowedGroups == null) {
        delete process.env.CHATLUNA_COMMON_FS_ALLOWED_GROUPS;
      } else {
        process.env.CHATLUNA_COMMON_FS_ALLOWED_GROUPS = previousFileToolAllowedGroups;
      }
    }
  }

  return {
    ctx,
    database,
    extend,
    registerToolMaskResolver,
    toolRegistry,
    setChatLunaAvailable(available: boolean) {
      currentChatLuna = available ? chatluna : undefined;
      ctx.chatluna = currentChatLuna;
    },
    async runReady() {
      for (const handler of readyHandlers) await handler();
    },
  };
}

describe('tool policy service', () => {
  it('gives affinity proactive generation only the terminal reply tool', () => {
    expect(AFFINITY_PROACTIVE_TOOL_MASK_POLICY).toEqual({
      id: 'affinity_proactive_generation',
      allowedTools: [QQBOT_SUBMIT_REPLY_TOOL_NAME],
    });
    expect(createAffinityProactiveToolMask()).toEqual({
      mode: 'allow',
      allow: [QQBOT_SUBMIT_REPLY_TOOL_NAME],
      deny: [],
      toolCallMask: {
        mode: 'allow',
        allow: [QQBOT_SUBMIT_REPLY_TOOL_NAME],
        deny: [],
      },
    });
  });

  it('declares runtime services as required injections', () => {
    expect(inject).toEqual({ required: ['database', 'chatluna', 'featurePolicy'] });
  });

  it('registers the internal terminal reply tool outside user policy state', () => {
    const { toolRegistry } = createHarness();
    expect(toolRegistry[QQBOT_SUBMIT_REPLY_TOOL_NAME]).toEqual(expect.objectContaining({
      name: QQBOT_SUBMIT_REPLY_TOOL_NAME,
      meta: expect.objectContaining({
        group: 'qqbot-internal',
      }),
    }));
  });

  it('fails fast without the required database service', () => {
    expect(() => apply({
      chatluna: {},
      model: { extend: vi.fn() },
      on: vi.fn(),
    } as any)).toThrow('tool-policy requires database service.');
  });

  it('fails fast without the required feature policy service', () => {
    expect(() => apply({
      database: createDatabase(),
      chatluna: {},
      model: { extend: vi.fn() },
      on: vi.fn(),
    } as any)).toThrow('tool-policy requires featurePolicy service.');
  });

  it('resolves scoped overrides for agent with private and group precedence', async () => {
    const { ctx } = createHarness();
    const service = ctx.toolPolicy!;

    await service.saveToolOverrides([
      {
        toolName: 'web_run',
        routeProfile: 'agent',
        scopeKind: 'global_default',
        scopeId: GLOBAL_DEFAULT_SCOPE_ID,
        enabled: false,
      },
      {
        toolName: 'web_run',
        routeProfile: 'agent',
        scopeKind: 'private_default',
        scopeId: PRIVATE_DEFAULT_SCOPE_ID,
        enabled: true,
      },
      {
        toolName: 'web_run',
        routeProfile: 'agent',
        scopeKind: 'group',
        scopeId: '1091078473',
        enabled: false,
      },
    ]);

    await expect(
      service.resolveAllowedTools({
        session: { isDirect: true, userId: 'u1', channelId: 'private-1' },
        routeProfile: 'agent',
        toolNames: ['web_run'],
        room: { roomId: 7, conversationId: 'conv-private' },
      }),
    ).resolves.toEqual({
      allowed: ['web_run'],
      unknown: [],
    });

    await expect(
      service.resolveAllowedTools({
        session: { isDirect: false, userId: 'u1', guildId: '1091078473', channelId: '1091078473' },
        routeProfile: 'agent',
        toolNames: ['web_run'],
        room: { roomId: 101, conversationId: 'conv-group' },
      }),
    ).resolves.toEqual({
      allowed: [],
      unknown: [],
    });
  });

  it('filters unknown tools and exposes state for admin', async () => {
    const { ctx } = createHarness();
    const service = ctx.toolPolicy!;

    const state = await service.getToolPolicyState();
    expect(state.catalog.length).toBe(TOOL_CATALOG.length);
    expect(state.catalog.find((tool: ToolCatalogEntry) => tool.toolName === 'web_run')).toEqual(
      expect.objectContaining({ registered: true }),
    );
    expect(state.catalog.find((tool: ToolCatalogEntry) => tool.toolName === 'file_read')).toEqual(
      expect.objectContaining({ registered: true }),
    );
    expect(state.catalog.find((tool: ToolCatalogEntry) => tool.toolName === 'qqbot_attachment_replay')).toEqual(
      expect.objectContaining({ registered: false }),
    );
    expect(state.routeProfiles).toEqual([
      'agent',
      'automation',
    ]);
    expect(state.routeProfileInfo).toEqual([
      expect.objectContaining({ id: 'agent' }),
      expect.objectContaining({ id: 'automation' }),
    ]);
    expect(state.defaultScopes).toEqual([
      expect.objectContaining({ scopeKind: 'global_default', scopeId: GLOBAL_DEFAULT_SCOPE_ID }),
      expect.objectContaining({ scopeKind: 'private_default', scopeId: PRIVATE_DEFAULT_SCOPE_ID }),
    ]);
    expect(state.scopes).toEqual([
      expect.objectContaining({ scopeKind: 'global_default', scopeId: GLOBAL_DEFAULT_SCOPE_ID }),
      expect.objectContaining({ scopeKind: 'private_default', scopeId: PRIVATE_DEFAULT_SCOPE_ID }),
      expect.objectContaining({ scopeKind: 'private_conversation', scopeId: '7' }),
    ]);
    expect(state.conversationTargets).toEqual([
      expect.objectContaining({ scopeKind: 'private', scopeId: '7' }),
    ]);

    await expect(
      service.resolveAllowedTools({
        session: { isDirect: false, userId: 'u1', guildId: '1', channelId: '1' },
        routeProfile: 'agent',
        toolNames: ['web_run', QQBOT_SUBMIT_REPLY_TOOL_NAME, 'unknown_runtime_tool'],
      }),
    ).resolves.toEqual({
      allowed: ['web_run'],
      unknown: ['unknown_runtime_tool'],
    });
  });

  it('registers a route-aware tool-mask resolver and filters agent/tools separately', async () => {
    const { ctx, registerToolMaskResolver, runReady } = createHarness({}, {
      fileToolAllowedGroups: '1091330365',
    });
    await runReady();
    await ctx.toolPolicy.saveToolOverrides([{
      toolName: 'web_run',
      routeProfile: 'automation',
      scopeKind: 'global_default',
      scopeId: GLOBAL_DEFAULT_SCOPE_ID,
      enabled: false,
    }]);
    expect(registerToolMaskResolver).toHaveBeenCalledTimes(1);
    const resolver = registerToolMaskResolver.mock.calls[0]?.[1] as
      | ((arg: {
          session: { isDirect: boolean; userId: string; guildId: string; channelId: string };
          conversation?: { id: string; legacyRoomId?: number; chatMode: string };
        }) => Promise<unknown>)
      | undefined;
    expect(resolver).toBeTypeOf('function');
    if (!resolver) {
      throw new Error('tool mask resolver was not registered');
    }

    await expect(
      resolver({
        session: { isDirect: false, userId: 'u1', guildId: '1091330365', channelId: '1091330365' },
      }),
    ).resolves.toEqual({
      mode: 'allow',
      allow: ['bash', 'file_edit', 'file_publish', 'file_read', 'file_write', 'glob', 'grep', 'web_run'],
      deny: [],
      toolCallMask: {
        mode: 'allow',
        allow: ['bash', 'file_edit', 'file_publish', 'file_read', 'file_write', 'glob', 'grep', 'web_run'],
        deny: [],
      },
    });

    await expect(
      resolver({
        session: { isDirect: false, userId: 'u1', guildId: '1091330365', channelId: '1091330365' },
        conversation: { id: 'conv-group', legacyRoomId: 115, chatMode: 'plugin' },
      }),
    ).resolves.toEqual({
      mode: 'allow',
      allow: ['bash', 'file_edit', 'file_publish', 'file_read', 'file_write', 'glob', 'grep', 'web_run'],
      deny: [],
      toolCallMask: {
        mode: 'allow',
        allow: ['bash', 'file_edit', 'file_publish', 'file_read', 'file_write', 'glob', 'grep', 'web_run'],
        deny: [],
      },
    });

    await expect(
      resolver({
        session: { isDirect: false, userId: 'u1', guildId: '1091330365', channelId: '1091330365' },
        conversation: { id: 'conv-automation', legacyRoomId: 115, chatMode: 'automation' },
      }),
    ).resolves.toEqual({
      mode: 'allow',
      allow: ['bash', 'file_edit', 'file_publish', 'file_read', 'file_write', 'glob', 'grep'],
      deny: [],
      toolCallMask: {
        mode: 'allow',
        allow: ['bash', 'file_edit', 'file_publish', 'file_read', 'file_write', 'glob', 'grep'],
        deny: [],
      },
    });
  });

  it('keeps product-locked Agent tools disabled for every scope', async () => {
    const { ctx } = createHarness();
    const service = ctx.toolPolicy!;

    await expect(service.resolveAllowedTools({
      session: { isDirect: true, userId: 'u1', channelId: 'private-1' },
      routeProfile: 'agent',
      toolNames: ['question', 'task', 'hbu_jw_course_guidance_context', 'cf_user_profile'],
      room: { roomId: 7, conversationId: 'conv-private' },
    })).resolves.toEqual({ allowed: [], unknown: [] });

    await expect(service.saveToolOverrides([{
      toolName: 'question',
      routeProfile: 'agent',
      scopeKind: 'global_default',
      scopeId: GLOBAL_DEFAULT_SCOPE_ID,
      enabled: true,
    }])).rejects.toThrow('保持关闭');
  });

  it('hides file system tools from model masks outside the group allowlist', async () => {
    const { ctx } = createHarness({}, {
      fileToolAllowedGroups: '829573670, guild:921554872',
    });
    const service = ctx.toolPolicy!;
    const restrictedTools = ['bash', 'file_edit', 'file_publish', 'file_read', 'file_write', 'glob', 'grep'];

    const allowedGroupMask = await service.resolveToolMask(
      { isDirect: false, userId: 'u1', guildId: '829573670', channelId: '829573670' } as any,
      'agent',
      { roomId: 111, conversationId: 'conv-allowed' },
    );
    expect(allowedGroupMask.allow).toEqual([
      'bash',
      'file_edit',
      'file_publish',
      'file_read',
      'file_write',
      'glob',
      'grep',
      'web_run',
    ]);
    expect(allowedGroupMask.toolCallMask?.allow).toEqual(allowedGroupMask.allow);

    const blockedGroupMask = await service.resolveToolMask(
      { isDirect: false, userId: 'u1', guildId: '1091330365', channelId: '1091330365' } as any,
      'agent',
      { roomId: 115, conversationId: 'conv-blocked' },
    );
    expect(blockedGroupMask.allow).toEqual(['web_run']);
    for (const toolName of restrictedTools) {
      expect(blockedGroupMask.allow).not.toContain(toolName);
      expect(blockedGroupMask.toolCallMask?.allow).not.toContain(toolName);
    }

    const privateMask = await service.resolveToolMask(
      { isDirect: true, userId: 'u1', channelId: 'private-1' } as any,
      'agent',
      { roomId: 7, conversationId: 'conv-private' },
    );
    for (const toolName of restrictedTools) {
      expect(privateMask.allow).toContain(toolName);
      expect(privateMask.toolCallMask?.allow).toContain(toolName);
    }
  });

  it('fails closed during apply when the required ChatLuna registry is unavailable', () => {
    expect(() => createHarness({}, {
      initialChatLunaAvailable: false,
    })).toThrow(/registerTool.*internal reply finalization/i);
  });

  it('drops removed web overrides and migrates current file aliases', async () => {
    const { ctx, database } = createHarness({
      tool_scope_override: [
        {
          id: 1,
          toolName: 'web_fetch',
          routeProfile: 'agent',
          scopeKind: 'global_default',
          scopeId: GLOBAL_DEFAULT_SCOPE_ID,
          enabled: 1,
          updatedAt: 10,
        },
        {
          id: 2,
          toolName: 'built_user_toast',
          routeProfile: 'agent',
          scopeKind: 'global_default',
          scopeId: GLOBAL_DEFAULT_SCOPE_ID,
          enabled: 0,
          updatedAt: 11,
        },
        {
          id: 3,
          toolName: 'ghost_tool',
          routeProfile: 'agent',
          scopeKind: 'group',
          scopeId: '1001',
          enabled: 1,
          updatedAt: 12,
        },
        {
          id: 4,
          toolName: 'web_poster',
          routeProfile: 'agent',
          scopeKind: 'group',
          scopeId: '1002',
          enabled: 1,
          updatedAt: 13,
        },
        {
          id: 5,
          toolName: 'file_update',
          routeProfile: 'agent',
          scopeKind: 'group',
          scopeId: '1003',
          enabled: 1,
          updatedAt: 14,
        },
      ],
    });
    const service = ctx.toolPolicy!;

    await expect(service.getToolOverrides()).resolves.toEqual([
      expect.objectContaining({
        id: 5,
        toolName: 'file_edit',
        routeProfile: 'agent',
        scopeKind: 'group',
        scopeId: '1003',
        enabled: 1,
      }),
    ]);

    await expect(database.get('tool_scope_override', {})).resolves.toEqual([
      expect.objectContaining({
        id: 5,
        toolName: 'file_edit',
        routeProfile: 'agent',
        scopeKind: 'group',
        scopeId: '1003',
      }),
    ]);
  });
});
