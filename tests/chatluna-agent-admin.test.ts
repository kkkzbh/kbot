import { describe, expect, it, vi } from 'vitest';
import {
  ChatLunaAgentAdminService,
  type ChatLunaAgentRuntimeService,
} from '../src/plugins/admin-api/chatluna-agent-admin.js';
import { AdminHttpError } from '../src/plugins/shared/internal-access-policy.js';

function createRuntime(): ChatLunaAgentRuntimeService {
  const config = {
    version: 1,
    mcp: {
      mcpServers: {
        knowledge: {
          type: 'http' as const,
          url: 'https://mcp.internal.example',
          env: {
            ACCESS_TOKEN: 'mcp-env-secret',
          },
          headers: {
            Authorization: 'Bearer mcp-header-secret',
            'X-Tenant': 'tenant-secret',
          },
          timeout: 30,
        },
      },
      tools: {},
    },
    skills: {
      dirs: ['/opt/qqbot/skills'],
      items: {},
      githubToken: 'github-secret',
    },
    computer: {
      defaultProvider: 'local' as const,
      idleTimeoutMs: 600_000,
      local: {
        enabled: true,
        sandboxMode: 'workspace-write' as const,
        approvalMode: 'on-request' as const,
        dangerouslySkipPermissions: false,
        preferredShell: 'auto' as const,
        scopePath: '/opt/qqbot/app',
        readOnlyRoots: [],
        denyRoots: ['/opt/qqbot/shared'],
        ignores: ['**/.git/**'],
        allowedCommands: [],
        blockedCommands: [],
        commandTimeoutMs: 30_000,
        networkPolicy: 'block' as const,
      },
      e2b: {
        enabled: false,
        apiKey: 'e2b-secret',
        template: 'base',
        desktopTemplate: '',
        timeoutMs: 300_000,
        keepAlive: true,
      },
      openTerminal: {
        enabled: false,
        baseUrl: '',
        apiKey: 'terminal-secret',
        deploymentMode: 'unknown' as const,
        userIsolation: false,
      },
    },
    subAgent: {
      dirs: [],
      items: {},
      builtin: {},
      presetAgents: {},
      defaults: {
        skills: { mode: 'deny' as const, allow: [], deny: [] },
        mcp: { mode: 'deny' as const, allow: [], deny: [] },
        tools: { mode: 'deny' as const, allow: [], deny: [] },
        computer: { mode: 'allow' as const, allow: [], deny: [] },
      },
    },
    tool: {
      items: {},
      registry: {},
    },
    trigger: {
      providers: {},
    },
  };
  const tool = (name: string) => ({
    name,
    description: `${name} tool`,
    enabled: true,
    main: true,
    chatlunaEnabled: true,
    characterEnabled: true,
    characterGroupEnabled: true,
    characterPrivateEnabled: true,
    characterGroupMode: 'all' as const,
    characterPrivateMode: 'all' as const,
    characterGroupIds: [],
    characterPrivateIds: [],
    subAgents: { mode: 'all' as const, allow: [], deny: [] },
    authority: 3,
    source: 'builtin',
    group: 'computer',
    tags: [],
    isMcp: false,
  });
  const computerStatus = {
    enabled: true,
    defaultProvider: 'local' as const,
    backends: {
      local: {
        type: 'local' as const,
        state: 'connected' as const,
        capabilities: ['file_read' as const, 'bash' as const],
        sessionCount: 0,
      },
      e2b: {
        type: 'e2b' as const,
        state: 'idle' as const,
        capabilities: [],
        sessionCount: 0,
      },
      'open-terminal': {
        type: 'open-terminal' as const,
        state: 'idle' as const,
        capabilities: [],
        sessionCount: 0,
      },
    },
    activeSessions: 0,
  };

  return {
    getConsoleData: () => ({
      config,
      status: {
        mcp: {
          connected: true,
          servers: {
            knowledge: {
              name: 'knowledge',
              state: 'connected',
              stateText: '已连接',
              connected: true,
              updating: false,
              toolCount: 0,
              attempts: 0,
              maxAttempts: 5,
              pendingReconnect: false,
            },
          },
          tools: {},
        },
        skills: {
          enabled: true,
          root: '/opt/qqbot/data/chatluna/skills',
          total: 0,
          visible: 0,
          modelEnabled: 0,
          activeConversations: 0,
          catalog: {},
        },
        computer: computerStatus,
        subAgent: {
          enabled: true,
          total: 0,
          catalog: {},
          runs: [],
        },
        tool: {
          enabled: true,
          total: 3,
          mainEnabled: 3,
          subAgentEnabled: 3,
          catalog: {
            skill: tool('skill'),
            file_read: tool('file_read'),
            bash: tool('bash'),
          },
        },
        trigger: {
          total: 0,
          enabled: 0,
          scheduled: 0,
          passive: 0,
        },
      },
    }),
    refreshConsoleData: vi.fn(),
    reloadMcp: vi.fn(),
    saveMcpServer: vi.fn(),
    removeMcpServer: vi.fn(),
    saveMcpTool: vi.fn(),
    saveSkillsConfig: vi.fn(),
    setSkillMode: vi.fn(),
    removeSkill: vi.fn(),
    importSkills: vi.fn(),
    saveComputerConfig: vi.fn(),
    saveSubAgentConfig: vi.fn(),
    addSubAgent: vi.fn(),
    saveSubAgentContent: vi.fn(),
    setSubAgentEnabled: vi.fn(),
    removeSubAgent: vi.fn(),
    reloadSubAgents: vi.fn(),
    saveToolConfig: vi.fn(),
    setTriggerProviderEnabled: vi.fn(),
    skills: {
      listSkills: () => [],
      getSkillContent: vi.fn(),
      saveSkillContent: vi.fn(),
      reload: vi.fn(),
    },
    subAgent: {
      getCatalogSync: () => [],
      getRuns: () => [],
    },
    mcp: {
      reconnect: vi.fn(),
    },
    computer: {
      testBackend: vi.fn(),
    },
    trigger: {
      listProviders: () => [],
      listTasks: async () => [],
      listRoutingChoices: () => [],
      createTask: vi.fn(),
      updateTask: vi.fn(),
      setEnabled: vi.fn(),
      removeTask: vi.fn(),
      fire: vi.fn(),
    },
  };
}

describe('ChatLuna Agent Admin boundary', () => {
  it('returns capability state without returning managed secrets', async () => {
    const service = new ChatLunaAgentAdminService(createRuntime());

    const state = await service.getState();
    const serialized = JSON.stringify(state);

    expect(state.mcp.servers[0]).toMatchObject({
      name: 'knowledge',
      envKeys: ['ACCESS_TOKEN'],
      headerKeys: ['Authorization', 'X-Tenant'],
    });
    expect(state.skills.githubTokenConfigured).toBe(true);
    expect(state.computer.config.e2b.apiKeyConfigured).toBe(true);
    expect(state.computer.config.openTerminal.apiKeyConfigured).toBe(true);
    expect(state.tools.catalog.map((tool) => tool.name)).toEqual([
      'bash',
      'file_read',
      'skill',
    ]);
    expect(serialized).not.toContain('mcp-env-secret');
    expect(serialized).not.toContain('mcp-header-secret');
    expect(serialized).not.toContain('github-secret');
    expect(serialized).not.toContain('e2b-secret');
    expect(serialized).not.toContain('terminal-secret');
  });

  it('applies explicit MCP secret mutations while preserving configured values', async () => {
    const runtime = createRuntime();
    const service = new ChatLunaAgentAdminService(runtime);

    await service.saveMcpServer({
      oldName: 'knowledge',
      name: 'knowledge',
      config: {
        type: 'http',
        url: 'https://mcp.internal.example/v2',
        args: [],
        timeout: 45,
        env: [
          { name: 'ACCESS_TOKEN', update: { operation: 'keep' } },
          { name: 'NEW_TOKEN', update: { operation: 'set', value: 'new-secret' } },
        ],
        headers: [
          { name: 'Authorization', update: { operation: 'keep' } },
          { name: 'X-Tenant', update: { operation: 'clear' } },
        ],
      },
    });

    expect(runtime.saveMcpServer).toHaveBeenCalledWith({
      oldName: 'knowledge',
      name: 'knowledge',
      config: {
        type: 'http',
        url: 'https://mcp.internal.example/v2',
        timeout: 45,
        env: {
          ACCESS_TOKEN: 'mcp-env-secret',
          NEW_TOKEN: 'new-secret',
        },
        headers: {
          Authorization: 'Bearer mcp-header-secret',
        },
      },
    });
  });

  it('rejects keep when no persisted secret exists', async () => {
    const runtime = createRuntime();
    const service = new ChatLunaAgentAdminService(runtime);

    await expect(service.saveMcpServer({
      oldName: 'knowledge',
      name: 'knowledge',
      config: {
        type: 'http',
        url: 'https://mcp.internal.example',
        args: [],
        env: [{ name: 'MISSING', update: { operation: 'keep' } }],
        headers: [],
      },
    })).rejects.toEqual(expect.objectContaining<Partial<AdminHttpError>>({
      status: 400,
      code: 'bad_request',
    }));
  });

  it('saves project-owned Skill permissions without exposing or dropping the GitHub token', async () => {
    const runtime = createRuntime();
    runtime.skills.listSkills = () => [{
      id: 'research',
      name: 'research',
      remote: true,
    } as any];
    const service = new ChatLunaAgentAdminService(runtime);

    await service.saveSkillConfig('research', {
      enabled: true,
      mode: 'description',
      authority: 3,
      main: true,
      chatluna: true,
      character: false,
      characterGroup: false,
      characterPrivate: false,
      characterGroupMode: 'deny',
      characterPrivateMode: 'allow',
      characterGroupIds: ['100'],
      characterPrivateIds: ['200'],
      subAgents: { mode: 'allow', allow: ['reader'], deny: [] },
    });

    expect(runtime.saveSkillsConfig).toHaveBeenCalledWith({
      dirs: ['/opt/qqbot/skills'],
      githubToken: 'github-secret',
      items: {
        research: {
          enabled: true,
          mode: 'description',
          authority: 3,
          main: true,
          chatluna: true,
          character: false,
          characterGroup: false,
          characterPrivate: false,
          characterGroupMode: 'deny',
          characterPrivateMode: 'allow',
          characterGroupIds: ['100'],
          characterPrivateIds: ['200'],
          subAgents: { mode: 'allow', allow: ['reader'], deny: [] },
          remote: true,
        },
      },
    });
  });
});
