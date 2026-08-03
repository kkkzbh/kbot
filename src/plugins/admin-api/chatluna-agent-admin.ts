import type {
  AgentAdminState,
  AgentComputerBackendStatus,
  AgentComputerConfigPut,
  AgentMcpServerPut,
  AgentMcpServerStatus,
  AgentMcpToolAdmin,
  AgentPodmanWorkspace,
  AgentSecretEntry,
  AgentSecretUpdate,
  AgentSkillAdmin,
  AgentSkillConfigPut,
  AgentToolAdmin,
  AgentToolPut,
} from '../../admin/contracts/agent.js';
import {
  AGENT_TOOL_PLUGIN_MAP,
  AGENT_TOOL_PLUGINS,
  TOOL_CATALOG_MAP,
} from '../shared/tool-policy-catalog.js';
import { AdminHttpError } from '../shared/internal-access-policy.js';

type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'stdio' | 'sse' | 'http' | 'streamable_http';
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  cwd?: string;
  proxy?: string;
};

type RuntimeComputerConfig = AgentComputerConfigPut['config'] & {
  e2b: AgentComputerConfigPut['config']['e2b'] & { apiKey: string };
  openTerminal: AgentComputerConfigPut['config']['openTerminal'] & { apiKey: string };
};

type RuntimeAgentSkill = AgentSkillAdmin & {
  path: string;
  dir: string;
  subAgents?: unknown;
};

type RuntimeAgentTool = AgentToolAdmin & { subAgents: unknown };

type RuntimeToolItemConfig = {
  enabled: boolean;
  main: boolean;
  chatluna: boolean;
  character: boolean;
  characterGroup: boolean;
  characterPrivate: boolean;
  characterGroupMode: 'all' | 'allow' | 'deny';
  characterPrivateMode: 'all' | 'allow' | 'deny';
  characterGroupIds: string[];
  characterPrivateIds: string[];
  subAgents: unknown;
  authority: number;
};

type RuntimeAgentConfig = {
  version: number;
  mcp: {
    mcpServers: Record<string, McpServerConfig>;
    tools: Record<string, {
      name: string;
      enabled: boolean;
      timeout?: number;
      selector: string[];
    }>;
  };
  skills: {
    dirs: string[];
    items: Record<string, unknown>;
    githubToken?: string;
  };
  tool: {
    items: Record<string, RuntimeToolItemConfig>;
    registry?: Record<string, unknown>;
  };
  computer: RuntimeComputerConfig;
  [key: string]: unknown;
};

type RuntimeAgentStatus = {
  mcp: {
    servers: Record<string, AgentMcpServerStatus>;
    tools: Record<string, AgentMcpToolAdmin>;
  };
  computer: NonNullable<AgentAdminState['plugins']['catalog'][number]['computer']>['status'];
  tool: {
    catalog: Record<string, RuntimeAgentTool>;
  };
};

export interface ChatLunaAgentRuntimeService {
  getConsoleData(): { config: RuntimeAgentConfig; status: RuntimeAgentStatus };
  refreshConsoleData(): Promise<void>;
  reloadMcp(): Promise<void>;
  saveMcpServer(input: {
    oldName?: string;
    name: string;
    config: McpServerConfig;
  }): Promise<void>;
  removeMcpServer(name: string): Promise<void>;
  saveMcpTool(input: {
    name: string;
    enabled: boolean;
    timeout?: number;
    selector: string[];
  }): Promise<void>;
  saveConfig(input: RuntimeAgentConfig): Promise<void>;
  saveComputerConfig(input: RuntimeComputerConfig): Promise<void>;
  saveToolConfig(input: RuntimeAgentConfig['tool']): Promise<void>;
  saveSkillsConfig(input: unknown): Promise<void>;
  setSkillMode(id: string, mode: 'off' | 'description' | 'full'): Promise<void>;
  removeSkill(id: string): Promise<void>;
  importSkills(input: {
    type: 'github';
    url: string;
    selected?: string[];
  }): Promise<unknown>;
  skills: {
    listSkills(): RuntimeAgentSkill[];
    getSkillContent(id: string): Promise<{ id: string; content: string } | undefined>;
    saveSkillContent(id: string, content: string): Promise<boolean | void>;
    reload(): Promise<void>;
  };
  mcp: {
    reconnect(name: string): Promise<void>;
  };
  computer: {
    testBackend(
      type: 'podman' | 'e2b' | 'open-terminal',
    ): Promise<AgentComputerBackendStatus>;
    listWorkspaces(): Promise<AgentPodmanWorkspace[]>;
    stopWorkspace(id: string): Promise<void>;
    resetWorkspace(id: string): Promise<void>;
  };
}

function cleanOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveSecret(
  current: string | undefined,
  update: AgentSecretUpdate,
  label: string,
): string {
  if (update.operation === 'keep') {
    if (!current) {
      throw new AdminHttpError(
        400,
        'bad_request',
        `${label} 当前没有已保存的 Secret，无法执行 keep。`,
      );
    }
    return current;
  }
  if (update.operation === 'clear') return '';
  return update.value;
}

function resolveSecretEntries(
  current: Record<string, string> | undefined,
  entries: readonly AgentSecretEntry[],
  label: string,
): Record<string, string> {
  const previous = current ?? {};
  const next: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.update.operation === 'clear') continue;
    if (entry.update.operation === 'keep') {
      if (!Object.hasOwn(previous, entry.name)) {
        throw new AdminHttpError(
          400,
          'bad_request',
          `${label} ${entry.name} 当前没有已保存值，无法执行 keep。`,
        );
      }
      next[entry.name] = previous[entry.name];
      continue;
    }
    next[entry.name] = entry.update.value;
  }
  return next;
}

function createMcpConfig(
  input: AgentMcpServerPut,
  current: McpServerConfig | undefined,
): McpServerConfig {
  const env = resolveSecretEntries(current?.env, input.config.env, '环境变量');
  const headers = resolveSecretEntries(current?.headers, input.config.headers, 'HTTP Header');
  const common = {
    type: input.config.type,
    ...(input.config.timeout === undefined ? {} : { timeout: input.config.timeout }),
    ...(cleanOptional(input.config.cwd) ? { cwd: cleanOptional(input.config.cwd) } : {}),
    ...(cleanOptional(input.config.proxy) ? { proxy: cleanOptional(input.config.proxy) } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  } satisfies McpServerConfig;

  if (input.config.type === 'stdio') {
    return {
      ...common,
      command: input.config.command!.trim(),
      args: input.config.args,
    };
  }
  return {
    ...common,
    url: input.config.url!.trim(),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function computerAdminConfig(config: RuntimeComputerConfig) {
  return {
    defaultProvider: config.defaultProvider,
    idleTimeoutMs: config.idleTimeoutMs,
    podman: structuredClone(config.podman),
    e2b: {
      enabled: config.e2b.enabled,
      apiKeyConfigured: Boolean(config.e2b.apiKey),
      template: config.e2b.template,
      desktopTemplate: config.e2b.desktopTemplate,
      timeoutMs: config.e2b.timeoutMs,
      keepAlive: config.e2b.keepAlive,
    },
    openTerminal: {
      enabled: config.openTerminal.enabled,
      apiKeyConfigured: Boolean(config.openTerminal.apiKey),
      baseUrl: config.openTerminal.baseUrl,
      deploymentMode: config.openTerminal.deploymentMode,
      userIsolation: config.openTerminal.userIsolation,
    },
  };
}

function runtimeComputerConfig(
  current: RuntimeComputerConfig,
  input: AgentComputerConfigPut,
): RuntimeComputerConfig {
  return {
    ...structuredClone(input.config),
    e2b: {
      ...input.config.e2b,
      apiKey: resolveSecret(current.e2b.apiKey, input.e2bApiKey, 'E2B API Key'),
    },
    openTerminal: {
      ...input.config.openTerminal,
      apiKey: resolveSecret(
        current.openTerminal.apiKey,
        input.openTerminalApiKey,
        'OpenTerminal API Key',
      ),
    },
  };
}

function runtimeToolItem(
  tool: RuntimeAgentTool,
  enabled: boolean,
  main: boolean,
): RuntimeToolItemConfig {
  return {
    enabled,
    main,
    chatluna: tool.chatlunaEnabled,
    character: tool.characterEnabled,
    characterGroup: tool.characterGroupEnabled,
    characterPrivate: tool.characterPrivateEnabled,
    characterGroupMode: tool.characterGroupMode,
    characterPrivateMode: tool.characterPrivateMode,
    characterGroupIds: [...tool.characterGroupIds],
    characterPrivateIds: [...tool.characterPrivateIds],
    subAgents: structuredClone(tool.subAgents),
    authority: tool.authority,
  };
}

export class ChatLunaAgentAdminService {
  constructor(private readonly runtime: ChatLunaAgentRuntimeService) {}

  async getState(): Promise<AgentAdminState> {
    const data = this.runtime.getConsoleData();
    const skills = await Promise.resolve(this.runtime.skills.listSkills());
    const skillCatalog = skills.map((skill) => {
      const {
        path: _path,
        dir: _dir,
        subAgents: _subAgents,
        ...safe
      } = skill;
      return safe;
    });
    const toolCatalog = Object.values(data.status.tool.catalog).map((tool) => {
      const { subAgents: _subAgents, ...safe } = tool;
      return safe;
    });
    const computerStatus = data.status.computer;
    const computerTools = [...new Set(
      Object.values(computerStatus.backends).flatMap((backend) => backend.capabilities),
    )].sort();
    const defaultBackend = computerStatus.backends[computerStatus.defaultProvider];
    const toolsByName = new Map(toolCatalog.map((tool) => [tool.name, tool]));
    const plugins = AGENT_TOOL_PLUGINS.map((plugin) => {
      const tools = plugin.toolNames
        .map((name) => toolsByName.get(name))
        .filter((tool): tool is AgentToolAdmin => tool !== undefined);
      const enabled = tools.some((tool) => tool.enabled && tool.main);
      const workspace = plugin.kind === 'workspace';
      const active = workspace ? computerStatus.enabled || enabled : enabled;
      return {
        id: plugin.id,
        kind: plugin.kind,
        displayName: plugin.displayName,
        version: '1.0.0',
        shortDescription: plugin.shortDescription,
        longDescription: plugin.longDescription,
        developerName: 'QQBot',
        category: plugin.category,
        capabilities: [...plugin.capabilities],
        builtIn: true,
        configurable: plugin.lockedReason == null,
        removable: false,
        ...(plugin.lockedReason ? { lockedReason: plugin.lockedReason } : {}),
        state: plugin.lockedReason
          ? 'inactive' as const
          : workspace && computerStatus.enabled && defaultBackend.state === 'error'
            ? 'error' as const
            : active
              ? 'active' as const
              : 'inactive' as const,
        contents: {
          mcpServers: [],
          skills: [],
          tools: workspace
            ? [...new Set([...tools.map((tool) => tool.name), ...computerTools])].sort()
            : [...plugin.toolNames].sort(),
        },
        ...(workspace
          ? {
              computer: {
                config: computerAdminConfig(data.config.computer),
                status: computerStatus,
              },
            }
          : {}),
      };
    });

    return {
      generatedAt: Date.now(),
      version: data.config.version,
      mcp: {
        servers: Object.entries(data.config.mcp.mcpServers)
          .map(([name, config]) => ({
            name,
            type: config.type ?? (config.url ? 'http' : 'stdio'),
            command: config.command,
            args: config.args,
            url: config.url,
            timeout: config.timeout,
            cwd: config.cwd,
            proxy: config.proxy,
            envKeys: Object.keys(config.env ?? {}).sort(),
            headerKeys: Object.keys(config.headers ?? {}).sort(),
            status: data.status.mcp.servers[name] ?? null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        tools: Object.values(data.status.mcp.tools)
          .sort((a, b) => a.name.localeCompare(b.name)),
      },
      skills: {
        dirs: [...data.config.skills.dirs],
        githubTokenConfigured: Boolean(data.config.skills.githubToken),
        catalog: skillCatalog.sort((a, b) => a.name.localeCompare(b.name)),
      },
      tools: {
        catalog: toolCatalog.sort((a, b) => a.name.localeCompare(b.name)),
      },
      plugins: {
        catalog: plugins,
      },
    };
  }

  async saveMcpServer(input: AgentMcpServerPut): Promise<void> {
    const config = this.runtime.getConsoleData().config.mcp;
    const currentName = input.oldName ?? input.name;
    const current = config.mcpServers[currentName];
    if (input.oldName && !current) {
      throw new AdminHttpError(404, 'not_found', `MCP Server 不存在：${input.oldName}`);
    }
    if (
      input.oldName
      && input.oldName !== input.name
      && Object.hasOwn(config.mcpServers, input.name)
    ) {
      throw new AdminHttpError(409, 'conflict', `MCP Server 名称已存在：${input.name}`);
    }
    await this.runtime.saveMcpServer({
      oldName: input.oldName,
      name: input.name,
      config: createMcpConfig(input, current),
    });
  }

  async removeMcpServer(name: string): Promise<void> {
    if (!Object.hasOwn(this.runtime.getConsoleData().config.mcp.mcpServers, name)) {
      throw new AdminHttpError(404, 'not_found', `MCP Server 不存在：${name}`);
    }
    await this.runtime.removeMcpServer(name);
  }

  async saveMcpTool(
    name: string,
    input: { enabled: boolean; timeout?: number; selector: string[] },
  ): Promise<void> {
    const status = this.runtime.getConsoleData().status.mcp.tools[name];
    const configured = this.runtime.getConsoleData().config.mcp.tools[name];
    if (!status && !configured) {
      throw new AdminHttpError(404, 'not_found', `MCP Tool 不存在：${name}`);
    }
    await this.runtime.saveMcpTool({ name, ...input });
  }

  async saveTool(name: string, input: AgentToolPut): Promise<void> {
    const tool = this.runtime.getConsoleData().status.tool.catalog[name];
    const policy = TOOL_CATALOG_MAP.get(name);
    if (!tool || !policy) {
      throw new AdminHttpError(404, 'not_found', `Tool 不存在：${name}`);
    }
    if (tool.isMcp) {
      throw new AdminHttpError(409, 'conflict', 'MCP Tool 必须通过 MCP 配置更新。');
    }
    if (input.enabled && policy.management === 'locked_off') {
      throw new AdminHttpError(
        409,
        'conflict',
        policy.managementNote ?? `Tool 已锁定为关闭：${name}`,
      );
    }
    const config = this.runtime.getConsoleData().config.tool;
    await this.runtime.saveToolConfig({
      ...structuredClone(config),
      items: {
        ...structuredClone(config.items),
        [name]: runtimeToolItem(tool, input.enabled, input.main),
      },
    });
  }

  async savePluginState(id: string, enabled: boolean): Promise<void> {
    const plugin = AGENT_TOOL_PLUGIN_MAP.get(id);
    if (!plugin) throw new AdminHttpError(404, 'not_found', `Plugin 不存在：${id}`);
    if (enabled && plugin.lockedReason) {
      throw new AdminHttpError(409, 'conflict', plugin.lockedReason);
    }

    const data = this.runtime.getConsoleData();
    const tools = plugin.toolNames
      .map((name) => data.status.tool.catalog[name])
      .filter((tool): tool is RuntimeAgentTool => tool !== undefined);
    if (tools.length < 1) {
      throw new AdminHttpError(409, 'conflict', `Plugin 没有已注册 Tool：${id}`);
    }

    const tool = {
      ...structuredClone(data.config.tool),
      items: {
        ...structuredClone(data.config.tool.items),
        ...Object.fromEntries(
          tools.map((item) => [
            item.name,
            runtimeToolItem(item, enabled, enabled),
          ]),
        ),
      },
    };

    if (plugin.kind !== 'workspace') {
      await this.runtime.saveToolConfig(tool);
      return;
    }

    const computer = structuredClone(data.config.computer);
    if (!enabled) {
      computer.podman.enabled = false;
      computer.e2b.enabled = false;
      computer.openTerminal.enabled = false;
    } else if (computer.defaultProvider === 'podman') {
      computer.podman.enabled = true;
    } else if (computer.defaultProvider === 'e2b') {
      computer.e2b.enabled = true;
    } else {
      computer.openTerminal.enabled = true;
    }

    await this.runtime.saveConfig({
      ...structuredClone(data.config),
      computer,
      tool,
    });
  }

  async reconnectMcpServer(name: string): Promise<void> {
    await this.runtime.mcp.reconnect(name);
  }

  async reloadMcp(): Promise<void> {
    await this.runtime.reloadMcp();
  }

  async saveSkillsSettings(input: {
    dirs: string[];
    githubToken: AgentSecretUpdate;
  }): Promise<void> {
    const current = this.runtime.getConsoleData().config.skills;
    await this.runtime.saveSkillsConfig({
      dirs: input.dirs,
      items: structuredClone(current.items),
      githubToken: resolveSecret(current.githubToken, input.githubToken, 'GitHub Token'),
    });
  }

  async setSkillMode(id: string, mode: 'off' | 'description' | 'full'): Promise<void> {
    await this.runtime.setSkillMode(id, mode);
  }

  async saveSkillConfig(id: string, input: AgentSkillConfigPut): Promise<void> {
    const info = this.runtime.skills.listSkills().find((skill) => skill.id === id);
    if (!info) throw new AdminHttpError(404, 'not_found', `Skill 不存在：${id}`);
    const current = this.runtime.getConsoleData().config.skills;
    await this.runtime.saveSkillsConfig({
      dirs: [...current.dirs],
      githubToken: current.githubToken ?? '',
      items: {
        ...structuredClone(current.items),
        [id]: {
          ...structuredClone(input),
          subAgents: { mode: 'deny', allow: [], deny: [] },
          remote: info.remote === true,
        },
      },
    });
  }

  async getSkillContent(id: string) {
    const result = await this.runtime.skills.getSkillContent(id);
    if (!result) throw new AdminHttpError(404, 'not_found', `Skill 不存在：${id}`);
    return result;
  }

  async saveSkillContent(id: string, content: string): Promise<void> {
    const saved = await this.runtime.skills.saveSkillContent(id, content);
    if (saved === false) {
      throw new AdminHttpError(409, 'conflict', '这个 Skill 不允许从管理页修改。');
    }
    await this.runtime.skills.reload();
    await this.runtime.refreshConsoleData();
  }

  async removeSkill(id: string): Promise<void> {
    await this.runtime.removeSkill(id);
  }

  async importSkillFromGithub(input: { url: string; selected?: string[] }) {
    return await this.runtime.importSkills({ type: 'github', ...input });
  }

  async reloadSkills(): Promise<void> {
    await this.runtime.skills.reload();
    await this.runtime.refreshConsoleData();
  }

  async saveWorkspaceConfig(input: AgentComputerConfigPut): Promise<void> {
    const data = this.runtime.getConsoleData();
    const computer = runtimeComputerConfig(data.config.computer, input);
    await this.runtime.saveComputerConfig(computer);
  }

  async probeComputerBackend(type: 'podman' | 'e2b' | 'open-terminal') {
    return await this.runtime.computer.testBackend(type);
  }

  async listWorkspaces(): Promise<AgentPodmanWorkspace[]> {
    return await this.runtime.computer.listWorkspaces();
  }

  async stopWorkspace(id: string): Promise<void> {
    await this.runtime.computer.stopWorkspace(id);
  }

  async resetWorkspace(id: string): Promise<void> {
    await this.runtime.computer.resetWorkspace(id);
  }
}
