import type {
  AgentAdminState,
  AgentComputerBackendStatus,
  AgentComputerConfigPut,
  AgentMcpServerPut,
  AgentMcpServerStatus,
  AgentMcpToolAdmin,
  AgentSecretEntry,
  AgentSecretUpdate,
  AgentSkillAdmin,
  AgentSkillConfigPut,
  AgentSubAgentAdmin,
  AgentSubAgentInput,
  AgentSubAgentRunAdmin,
  AgentToolAdmin,
  AgentToolConfigPut,
  AgentTriggerProviderAdmin,
  AgentTriggerRoutingChoice,
  AgentTriggerTaskInput,
} from '../../admin/contracts/agent.js';
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

type RuntimeTriggerTask = Omit<
  AgentAdminState['trigger']['tasks'][number],
  'lastFiredAt' | 'nextFireAt' | 'createdAt' | 'updatedAt' | 'wakeupTemplate'
> & {
  wakeupTemplate: Record<string, unknown>;
  lastFiredAt?: Date | string | null;
  nextFireAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
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
  computer: RuntimeComputerConfig;
  subAgent: {
    dirs: string[];
    items: Record<string, unknown>;
    builtin: Record<string, unknown>;
    presetAgents: Record<string, unknown>;
    defaults: AgentAdminState['subAgents']['defaults'];
  };
  tool: {
    items: Record<string, AgentToolConfigPut>;
    registry?: Record<string, unknown>;
  };
  trigger: {
    providers: Record<string, { enabled: boolean }>;
  };
};

type RuntimeAgentStatus = {
  mcp: {
    connected: boolean;
    servers: Record<string, AgentMcpServerStatus>;
    tools: Record<string, AgentMcpToolAdmin>;
  };
  skills: AgentAdminState['status']['skills'] & {
    catalog: Record<string, AgentSkillAdmin & { path: string; dir: string }>;
  };
  computer: AgentAdminState['status']['computer'];
  subAgent: AgentAdminState['status']['subAgent'] & {
    catalog: Record<string, AgentSubAgentAdmin & { path?: string }>;
    runs: Array<AgentSubAgentRunAdmin & { trace: unknown[]; output?: string }>;
  };
  tool: AgentAdminState['status']['tool'] & {
    catalog: Record<string, AgentToolAdmin>;
  };
  trigger: AgentAdminState['status']['trigger'];
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
  saveSkillsConfig(input: unknown): Promise<void>;
  setSkillMode(id: string, mode: 'off' | 'description' | 'full'): Promise<void>;
  removeSkill(id: string): Promise<void>;
  importSkills(input: {
    type: 'github';
    url: string;
    selected?: string[];
  }): Promise<unknown>;
  saveComputerConfig(input: unknown): Promise<void>;
  saveSubAgentConfig(input: unknown): Promise<void>;
  addSubAgent(input: AgentSubAgentInput): Promise<unknown>;
  saveSubAgentContent(id: string, input: AgentSubAgentInput): Promise<unknown>;
  setSubAgentEnabled(id: string, enabled: boolean): Promise<void>;
  removeSubAgent(id: string): Promise<void>;
  reloadSubAgents(): Promise<void>;
  saveToolConfig(input: unknown): Promise<void>;
  setTriggerProviderEnabled(kind: string, enabled: boolean): Promise<void>;
  skills: {
    listSkills(): Array<AgentSkillAdmin & { path: string; dir: string }>;
    getSkillContent(id: string): Promise<{ id: string; content: string } | undefined>;
    saveSkillContent(id: string, content: string): Promise<boolean | void>;
    reload(): Promise<void>;
  };
  subAgent: {
    getCatalogSync(): Array<AgentSubAgentAdmin & { path?: string }>;
    getRuns(): Array<AgentSubAgentRunAdmin & { trace: unknown[]; output?: string }>;
  };
  mcp: {
    reconnect(name: string): Promise<void>;
  };
  computer: {
    testBackend(
      type: 'local' | 'e2b' | 'open-terminal',
    ): Promise<AgentComputerBackendStatus>;
  };
  trigger: {
    listProviders(): AgentTriggerProviderAdmin[];
    listTasks(): Promise<RuntimeTriggerTask[]>;
    listRoutingChoices(): AgentTriggerRoutingChoice[];
    createTask(input: unknown): Promise<unknown>;
    updateTask(id: number, input: unknown): Promise<unknown>;
    setEnabled(id: number, enabled: boolean): Promise<void>;
    removeTask(id: number): Promise<void>;
    fire(id: number): Promise<unknown>;
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

function serializeDate(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function sanitizeTriggerTask(task: RuntimeTriggerTask): AgentAdminState['trigger']['tasks'][number] {
  return {
    id: task.id,
    providerKind: task.providerKind ?? null,
    enabled: task.enabled,
    name: task.name ?? null,
    bindingKey: task.bindingKey,
    presetLane: task.presetLane ?? null,
    conversationId: task.conversationId ?? null,
    selfId: task.selfId,
    platform: task.platform,
    userId: task.userId,
    username: task.username ?? null,
    guildId: task.guildId ?? null,
    channelId: task.channelId ?? null,
    isDirect: task.isDirect,
    wakeupTemplate: task.wakeupTemplate as Record<string, unknown>,
    params: task.params ?? null,
    lastFiredAt: serializeDate(task.lastFiredAt),
    nextFireAt: serializeDate(task.nextFireAt),
    fireCount: task.fireCount,
    lastError: task.lastError ?? null,
    source: task.source,
    createdBy: task.createdBy,
    createdAt: serializeDate(task.createdAt) as string,
    updatedAt: serializeDate(task.updatedAt) as string,
  };
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

export class ChatLunaAgentAdminService {
  constructor(private readonly runtime: ChatLunaAgentRuntimeService) {}

  async getState(): Promise<AgentAdminState> {
    const data = this.runtime.getConsoleData();
    const [skills, subAgents, runs, providers, tasks, routingChoices] = await Promise.all([
      Promise.resolve(this.runtime.skills.listSkills()),
      Promise.resolve(this.runtime.subAgent.getCatalogSync()),
      Promise.resolve(this.runtime.subAgent.getRuns()),
      Promise.resolve(this.runtime.trigger.listProviders()),
      this.runtime.trigger.listTasks(),
      Promise.resolve(this.runtime.trigger.listRoutingChoices()),
    ]);
    const mcpStatus = data.status.mcp;
    const skillCatalog = skills.map((skill) => {
      const { path: _path, dir: _dir, ...safe } = skill;
      return safe;
    });
    const subAgentCatalog = subAgents.map((agent) => {
      const { path: _path, ...safe } = agent;
      return safe;
    });
    const runCatalog = runs.map((run) => {
      const { trace: _trace, output: _output, ...safe } = run;
      return safe;
    });

    return {
      generatedAt: Date.now(),
      version: data.config.version,
      status: {
        mcp: {
          connected: mcpStatus.connected,
          serverCount: Object.keys(mcpStatus.servers).length,
          connectedServers: Object.values(mcpStatus.servers).filter((server) => server.connected).length,
          toolCount: Object.keys(mcpStatus.tools).length,
        },
        skills: {
          enabled: data.status.skills.enabled,
          root: data.status.skills.root,
          total: data.status.skills.total,
          visible: data.status.skills.visible,
          modelEnabled: data.status.skills.modelEnabled,
          activeConversations: data.status.skills.activeConversations,
        },
        computer: data.status.computer,
        subAgent: {
          enabled: data.status.subAgent.enabled,
          total: data.status.subAgent.total,
        },
        tool: {
          enabled: data.status.tool.enabled,
          total: data.status.tool.total,
          mainEnabled: data.status.tool.mainEnabled,
          subAgentEnabled: data.status.tool.subAgentEnabled,
        },
        trigger: data.status.trigger,
      },
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
            status: mcpStatus.servers[name] ?? null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        tools: Object.values(mcpStatus.tools).sort((a, b) => a.name.localeCompare(b.name)),
      },
      skills: {
        dirs: [...data.config.skills.dirs],
        githubTokenConfigured: Boolean(data.config.skills.githubToken),
        catalog: skillCatalog.sort((a, b) => a.name.localeCompare(b.name)),
      },
      computer: {
        config: {
          defaultProvider: data.config.computer.defaultProvider,
          idleTimeoutMs: data.config.computer.idleTimeoutMs,
          local: structuredClone(data.config.computer.local),
          e2b: {
            enabled: data.config.computer.e2b.enabled,
            apiKeyConfigured: Boolean(data.config.computer.e2b.apiKey),
            template: data.config.computer.e2b.template,
            desktopTemplate: data.config.computer.e2b.desktopTemplate,
            timeoutMs: data.config.computer.e2b.timeoutMs,
            keepAlive: data.config.computer.e2b.keepAlive,
          },
          openTerminal: {
            enabled: data.config.computer.openTerminal.enabled,
            apiKeyConfigured: Boolean(data.config.computer.openTerminal.apiKey),
            baseUrl: data.config.computer.openTerminal.baseUrl,
            deploymentMode: data.config.computer.openTerminal.deploymentMode,
            userIsolation: data.config.computer.openTerminal.userIsolation,
          },
        },
        status: data.status.computer,
      },
      subAgents: {
        dirs: [...data.config.subAgent.dirs],
        defaults: structuredClone(data.config.subAgent.defaults),
        catalog: subAgentCatalog.sort((a, b) => a.name.localeCompare(b.name)),
        runs: runCatalog.sort((a, b) => b.startedAt - a.startedAt),
      },
      tools: {
        catalog: Object.values(data.status.tool.catalog).sort((a, b) => a.name.localeCompare(b.name)),
      },
      trigger: {
        providers: providers.map((provider) => ({
          kind: provider.kind,
          name: provider.name,
          description: provider.description,
          passive: provider.passive,
          scheduled: provider.scheduled,
          needsMessage: provider.needsMessage,
          enabled: provider.enabled,
        })),
        routingChoices,
        tasks: tasks.map(sanitizeTriggerTask),
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

  async saveComputerConfig(input: AgentComputerConfigPut): Promise<void> {
    const current = this.runtime.getConsoleData().config.computer;
    await this.runtime.saveComputerConfig({
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
    });
  }

  async probeComputerBackend(type: 'local' | 'e2b' | 'open-terminal') {
    return await this.runtime.computer.testBackend(type);
  }

  async saveSubAgentSettings(input: {
    dirs: string[];
    defaults: AgentAdminState['subAgents']['defaults'];
  }): Promise<void> {
    const current = this.runtime.getConsoleData().config.subAgent;
    await this.runtime.saveSubAgentConfig({
      ...structuredClone(current),
      dirs: input.dirs,
      defaults: structuredClone(input.defaults),
    });
  }

  async createSubAgent(input: AgentSubAgentInput) {
    return await this.runtime.addSubAgent(input);
  }

  async saveSubAgent(id: string, input: AgentSubAgentInput) {
    return await this.runtime.saveSubAgentContent(id, input);
  }

  async setSubAgentEnabled(id: string, enabled: boolean): Promise<void> {
    await this.runtime.setSubAgentEnabled(id, enabled);
  }

  async removeSubAgent(id: string): Promise<void> {
    await this.runtime.removeSubAgent(id);
  }

  async reloadSubAgents(): Promise<void> {
    await this.runtime.reloadSubAgents();
  }

  async saveTool(name: string, input: AgentToolConfigPut): Promise<void> {
    const current = this.runtime.getConsoleData();
    if (!Object.hasOwn(current.status.tool.catalog, name)) {
      throw new AdminHttpError(404, 'not_found', `Runtime Tool 不存在：${name}`);
    }
    await this.runtime.saveToolConfig({
      ...structuredClone(current.config.tool),
      items: {
        ...structuredClone(current.config.tool.items),
        [name]: structuredClone(input),
      },
    });
  }

  async setTriggerProviderEnabled(kind: string, enabled: boolean): Promise<void> {
    await this.runtime.setTriggerProviderEnabled(kind, enabled);
  }

  async createTriggerTask(input: AgentTriggerTaskInput) {
    return await this.runtime.trigger.createTask({
      ...input,
      source: 'webui',
      createdBy: 'qqbot-admin',
    });
  }

  async updateTriggerTask(id: number, input: AgentTriggerTaskInput) {
    return await this.runtime.trigger.updateTask(id, input);
  }

  async setTriggerTaskEnabled(id: number, enabled: boolean): Promise<void> {
    await this.runtime.trigger.setEnabled(id, enabled);
  }

  async removeTriggerTask(id: number): Promise<void> {
    await this.runtime.trigger.removeTask(id);
  }

  async fireTriggerTask(id: number) {
    return await this.runtime.trigger.fire(id);
  }
}
