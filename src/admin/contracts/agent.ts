import { z } from 'zod';

const nonEmptyIdSchema = z.string().trim().min(1).max(512);
const stringListSchema = z.array(z.string().trim().min(1).max(2048)).max(512);

export const agentSecretUpdateSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep') }).strict(),
  z.object({
    operation: z.literal('set'),
    value: z.string().min(1).max(65_536),
  }).strict(),
  z.object({ operation: z.literal('clear') }).strict(),
]);
export type AgentSecretUpdate = z.infer<typeof agentSecretUpdateSchema>;

export const agentSecretEntrySchema = z.object({
  name: z.string().trim().min(1).max(256),
  update: agentSecretUpdateSchema,
}).strict();
export type AgentSecretEntry = z.infer<typeof agentSecretEntrySchema>;

export const agentMcpServerPutSchema = z.object({
  oldName: z.string().trim().min(1).max(256).optional(),
  name: z.string().trim().min(1).max(256),
  config: z.object({
    type: z.enum(['stdio', 'sse', 'http', 'streamable_http']),
    command: z.string().trim().max(4096).optional(),
    args: stringListSchema.default([]),
    url: z.string().trim().max(8192).optional(),
    timeout: z.number().int().min(1).max(600).optional(),
    cwd: z.string().trim().max(4096).optional(),
    proxy: z.string().trim().max(8192).optional(),
    env: z.array(agentSecretEntrySchema).max(256).default([]),
    headers: z.array(agentSecretEntrySchema).max(256).default([]),
  }).strict().superRefine((config, context) => {
    if (config.type === 'stdio' && !config.command) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: 'stdio MCP Server 必须提供 command。',
      });
    }
    if (config.type !== 'stdio' && !config.url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: '远程 MCP Server 必须提供 URL。',
      });
    }
    for (const field of ['env', 'headers'] as const) {
      const names = config[field].map((entry) => entry.name);
      if (new Set(names).size !== names.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} 中存在重复名称。`,
        });
      }
    }
  }),
}).strict();
export type AgentMcpServerPut = z.infer<typeof agentMcpServerPutSchema>;

export const agentMcpToolPutSchema = z.object({
  enabled: z.boolean(),
  timeout: z.number().int().min(1).max(600).optional(),
  selector: stringListSchema.default([]),
}).strict();

export const agentSkillsSettingsPutSchema = z.object({
  dirs: stringListSchema,
  githubToken: agentSecretUpdateSchema,
}).strict();

export const agentSkillModePutSchema = z.object({
  mode: z.enum(['off', 'description', 'full']),
}).strict();

export const agentSkillContentPutSchema = z.object({
  content: z.string().min(1).max(2_000_000),
}).strict();

export const agentSkillGithubImportSchema = z.object({
  url: z.string().trim().url().max(8192),
  selected: stringListSchema.optional(),
}).strict();

export const agentComputerConfigPutSchema = z.object({
  config: z.object({
    defaultProvider: z.enum(['local', 'e2b', 'open-terminal']),
    idleTimeoutMs: z.number().int().min(10_000).max(86_400_000),
    local: z.object({
      enabled: z.boolean(),
      sandboxMode: z.enum(['read-only', 'workspace-write']),
      approvalMode: z.enum(['on-request', 'never']),
      dangerouslySkipPermissions: z.boolean(),
      preferredShell: z.enum(['git-bash', 'powershell', 'cmd', 'auto']),
      scopePath: z.string().trim().max(4096),
      readOnlyRoots: stringListSchema,
      denyRoots: stringListSchema,
      ignores: stringListSchema,
      allowedCommands: stringListSchema,
      blockedCommands: stringListSchema,
      commandTimeoutMs: z.number().int().min(1_000).max(3_600_000),
      networkPolicy: z.enum(['block', 'allow']),
    }).strict(),
    e2b: z.object({
      enabled: z.boolean(),
      template: z.string().trim().min(1).max(512),
      desktopTemplate: z.string().trim().max(512),
      timeoutMs: z.number().int().min(10_000).max(3_600_000),
      keepAlive: z.boolean(),
    }).strict(),
    openTerminal: z.object({
      enabled: z.boolean(),
      baseUrl: z.string().trim().max(8192),
      deploymentMode: z.enum(['docker', 'bare-metal', 'unknown']),
      userIsolation: z.boolean(),
    }).strict(),
  }).strict(),
  e2bApiKey: agentSecretUpdateSchema,
  openTerminalApiKey: agentSecretUpdateSchema,
}).strict();
export type AgentComputerConfigPut = z.infer<typeof agentComputerConfigPutSchema>;

const permissionRuleSchema = z.object({
  mode: z.enum(['inherit', 'all', 'allow', 'deny']),
  allow: stringListSchema,
  deny: stringListSchema,
}).strict();

export const agentSkillConfigPutSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['description', 'full']),
  authority: z.number().int().min(0).max(5),
  main: z.boolean(),
  chatluna: z.boolean(),
  character: z.boolean(),
  characterGroup: z.boolean(),
  characterPrivate: z.boolean(),
  characterGroupMode: z.enum(['all', 'allow', 'deny']),
  characterPrivateMode: z.enum(['all', 'allow', 'deny']),
  characterGroupIds: stringListSchema,
  characterPrivateIds: stringListSchema,
  subAgents: permissionRuleSchema,
}).strict();
export type AgentSkillConfigPut = z.infer<typeof agentSkillConfigPutSchema>;

const subAgentPermissionsSchema = z.object({
  skills: permissionRuleSchema,
  mcp: permissionRuleSchema,
  tools: permissionRuleSchema,
  computer: permissionRuleSchema,
}).strict();

export const agentSubAgentSettingsPutSchema = z.object({
  dirs: stringListSchema,
  defaults: subAgentPermissionsSchema,
}).strict();

export const agentSubAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(256),
  description: z.string().max(16_384).default(''),
  promptContent: z.string().max(2_000_000).default(''),
  dedupeTools: z.boolean().default(false),
  chatluna: z.boolean().default(true),
  character: z.boolean().default(true),
  characterGroup: z.boolean().default(true),
  characterPrivate: z.boolean().default(true),
  characterGroupMode: z.enum(['all', 'allow', 'deny']).default('all'),
  characterPrivateMode: z.enum(['all', 'allow', 'deny']).default('all'),
  characterGroupIds: stringListSchema.default([]),
  characterPrivateIds: stringListSchema.default([]),
  authority: z.number().int().min(0).max(5).default(0),
  format: z.enum(['chatluna', 'claude', 'opencode']).default('chatluna'),
  maxTurns: z.number().int().min(1).max(1_000).default(100),
  hidden: z.boolean().default(false),
  enabled: z.boolean().default(true),
  allowKoishiMessageTransform: z.boolean().default(false),
  permissions: subAgentPermissionsSchema,
}).strict();
export type AgentSubAgentInput = z.infer<typeof agentSubAgentInputSchema>;

export const agentEnabledPutSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const agentToolConfigPutSchema = z.object({
  enabled: z.boolean(),
  main: z.boolean(),
  chatluna: z.boolean(),
  character: z.boolean(),
  characterGroup: z.boolean(),
  characterPrivate: z.boolean(),
  characterGroupMode: z.enum(['all', 'allow', 'deny']),
  characterPrivateMode: z.enum(['all', 'allow', 'deny']),
  characterGroupIds: stringListSchema,
  characterPrivateIds: stringListSchema,
  subAgents: permissionRuleSchema,
  authority: z.number().int().min(0).max(5),
}).strict();
export type AgentToolConfigPut = z.infer<typeof agentToolConfigPutSchema>;

const triggerWakeupTemplateSchema = z.object({
  message: z.union([
    z.string().trim().min(1).max(200_000),
    z.array(z.unknown()).min(1).max(10_000),
  ]),
  messageName: z.string().trim().max(256).optional(),
  variables: z.record(z.unknown()).optional(),
  execMode: z.enum(['chain', 'direct']).optional(),
  chatMode: z.string().trim().max(128).optional(),
  replyTo: z.enum(['channel', 'user', 'silent', 'callback']).optional(),
  replyUserId: z.string().trim().max(256).optional(),
  timeout: z.number().int().min(1_000).max(3_600_000).optional(),
  newConversation: z.boolean().optional(),
  presetLane: z.string().trim().max(256).nullable().optional(),
  conversationId: z.string().trim().max(512).nullable().optional(),
  toolMask: z.unknown().optional(),
}).strict();

export const agentTriggerTaskInputSchema = z.object({
  providerKind: z.string().trim().min(1).max(64).nullable().optional(),
  enabled: z.boolean().default(true),
  name: z.string().trim().max(256).optional(),
  bindingKey: z.string().trim().min(1).max(512),
  presetLane: z.string().trim().max(256).nullable().optional(),
  conversationId: z.string().trim().max(512).nullable().optional(),
  selfId: nonEmptyIdSchema,
  platform: nonEmptyIdSchema,
  userId: nonEmptyIdSchema,
  username: z.string().trim().max(256).nullable().optional(),
  guildId: z.string().trim().max(256).nullable().optional(),
  channelId: z.string().trim().max(256).nullable().optional(),
  isDirect: z.boolean(),
  wakeupTemplate: triggerWakeupTemplateSchema,
  params: z.record(z.unknown()).nullable().optional(),
  nextFireAt: z.string().datetime().optional(),
}).strict();
export type AgentTriggerTaskInput = z.infer<typeof agentTriggerTaskInputSchema>;

export interface AgentMcpServerStatus {
  name: string;
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  stateText: string;
  connected: boolean;
  updating: boolean;
  error?: string;
  toolCount: number;
  attempts: number;
  maxAttempts: number;
  pendingReconnect: boolean;
  type?: string;
  endpoint?: string;
  title?: string;
  version?: string;
}

export interface AgentMcpToolAdmin {
  name: string;
  description: string;
  enabled: boolean;
  updating: boolean;
  server: string;
  timeout?: number;
  selector: string[];
  title?: string;
}

export type AgentMcpServerAdmin = {
  name: string;
  type: 'stdio' | 'sse' | 'http' | 'streamable_http';
  command?: string;
  args?: string[];
  url?: string;
  timeout?: number;
  cwd?: string;
  proxy?: string;
  envKeys: string[];
  headerKeys: string[];
  status: AgentMcpServerStatus | null;
};

export interface AgentPermissionRule {
  mode: 'inherit' | 'all' | 'allow' | 'deny';
  allow: string[];
  deny: string[];
}

export interface AgentSkillAdmin {
  id: string;
  name: string;
  description: string;
  remote?: boolean;
  source: 'chatluna' | 'openclaw' | 'codex' | 'universal' | 'claude' | 'opencode' | 'custom';
  scope: 'data' | 'project' | 'user';
  state: 'ready' | 'invalid' | 'missing';
  enabled: boolean;
  mode: 'off' | 'description' | 'full';
  authority: number;
  main: boolean;
  chatlunaEnabled: boolean;
  characterEnabled: boolean;
  characterGroupEnabled: boolean;
  characterPrivateEnabled: boolean;
  characterGroupMode: 'all' | 'allow' | 'deny';
  characterPrivateMode: 'all' | 'allow' | 'deny';
  characterGroupIds: string[];
  characterPrivateIds: string[];
  subAgents: AgentPermissionRule;
  available: boolean;
  visible: boolean;
  modelEnabled: boolean;
  userInvocable: boolean;
  implicitInvocation: boolean;
  shadowedBy?: string;
  emoji?: string;
  homepage?: string;
  skillKey?: string;
  primaryEnv?: string;
  compatibility?: string;
  license?: string;
  metadata?: Record<string, string>;
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  allowedTools?: string[];
  diagnostics: string[];
}

export interface AgentSubAgentPermissionConfig {
  skills: AgentPermissionRule;
  mcp: AgentPermissionRule;
  tools: AgentPermissionRule;
  computer: AgentPermissionRule;
}

export interface AgentSubAgentAdmin {
  id: string;
  name: string;
  description: string;
  dedupeTools: boolean;
  source: 'builtin' | 'markdown' | 'preset' | 'manual';
  format: 'chatluna' | 'claude' | 'opencode';
  state: 'ready' | 'invalid' | 'missing';
  enabled: boolean;
  chatlunaEnabled: boolean;
  characterEnabled: boolean;
  characterGroupEnabled: boolean;
  characterPrivateEnabled: boolean;
  characterGroupMode: 'all' | 'allow' | 'deny';
  characterPrivateMode: 'all' | 'allow' | 'deny';
  characterGroupIds: string[];
  characterPrivateIds: string[];
  authority: number;
  hidden: boolean;
  remote?: boolean;
  scope?: 'data' | 'project' | 'user';
  priority: number;
  promptContent: string;
  maxTurns?: number;
  permissions: AgentSubAgentPermissionConfig;
  allowKoishiMessageTransform: boolean;
  diagnostics: string[];
  shadowedBy?: string;
  promptMode: 'markdown' | 'preset';
  preset?: string;
}

export interface AgentSubAgentRunAdmin {
  runId: string;
  taskId: string;
  agentId: string;
  agentName: string;
  conversationId: string;
  parentConversationId: string;
  depth: number;
  state: 'running' | 'completed' | 'failed' | 'aborted';
  background?: boolean;
  startedAt: number;
  endedAt?: number;
  lastTool?: string;
  toolCount: number;
  turnCount: number;
  error?: string;
}

export interface AgentLocalComputerConfig {
  enabled: boolean;
  sandboxMode: 'read-only' | 'workspace-write';
  approvalMode: 'on-request' | 'never';
  dangerouslySkipPermissions: boolean;
  preferredShell: 'git-bash' | 'powershell' | 'cmd' | 'auto';
  scopePath: string;
  readOnlyRoots: string[];
  denyRoots: string[];
  ignores: string[];
  allowedCommands: string[];
  blockedCommands: string[];
  commandTimeoutMs: number;
  networkPolicy: 'block' | 'allow';
}

export interface AgentComputerBackendStatus {
  type: 'local' | 'e2b' | 'open-terminal';
  state: 'idle' | 'connecting' | 'connected' | 'error' | 'unsupported';
  error?: string;
  capabilities: Array<
    | 'file_read'
    | 'file_write'
    | 'file_edit'
    | 'file_publish'
    | 'grep'
    | 'glob'
    | 'bash'
    | 'terminal_pty'
    | 'desktop_stream'
    | 'desktop_screenshot'
    | 'desktop_action'
  >;
  sessionCount: number;
}

export interface AgentComputerStatus {
  enabled: boolean;
  defaultProvider: 'local' | 'e2b' | 'open-terminal';
  backends: Record<'local' | 'e2b' | 'open-terminal', AgentComputerBackendStatus>;
  activeSessions: number;
}

export interface AgentComputerAdminConfig {
  defaultProvider: 'local' | 'e2b' | 'open-terminal';
  idleTimeoutMs: number;
  local: AgentLocalComputerConfig;
  e2b: {
    enabled: boolean;
    template: string;
    desktopTemplate: string;
    timeoutMs: number;
    keepAlive: boolean;
    apiKeyConfigured: boolean;
  };
  openTerminal: {
    enabled: boolean;
    baseUrl: string;
    deploymentMode: 'docker' | 'bare-metal' | 'unknown';
    userIsolation: boolean;
    apiKeyConfigured: boolean;
  };
}

export interface AgentToolAdmin {
  name: string;
  description?: string;
  enabled: boolean;
  main: boolean;
  chatlunaEnabled: boolean;
  characterEnabled: boolean;
  characterGroupEnabled: boolean;
  characterPrivateEnabled: boolean;
  characterGroupMode: 'all' | 'allow' | 'deny';
  characterPrivateMode: 'all' | 'allow' | 'deny';
  characterGroupIds: string[];
  characterPrivateIds: string[];
  subAgents: AgentPermissionRule;
  authority: number;
  source?: string;
  group?: string;
  tags?: string[];
  isMcp: boolean;
  serverName?: string;
}

export interface AgentTriggerProviderAdmin {
  kind: string;
  name: string;
  description: string;
  passive?: boolean;
  scheduled?: boolean;
  needsMessage?: boolean;
  enabled?: boolean;
}

export interface AgentTriggerRoutingChoice {
  label: string;
  platform: string;
  selfId: string;
}

export interface AgentTriggerTaskAdmin {
  id: number;
  providerKind: string | null;
  enabled: boolean;
  name: string | null;
  bindingKey: string;
  presetLane: string | null;
  conversationId: string | null;
  selfId: string;
  platform: string;
  userId: string;
  username: string | null;
  guildId: string | null;
  channelId: string | null;
  isDirect: boolean;
  wakeupTemplate: Record<string, unknown>;
  params: Record<string, unknown> | null;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  fireCount: number;
  lastError: string | null;
  source: 'webui' | 'agent' | 'command' | 'plugin';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAdminState {
  generatedAt: number;
  version: number;
  status: {
    mcp: {
      connected: boolean;
      serverCount: number;
      connectedServers: number;
      toolCount: number;
    };
    skills: {
      enabled: boolean;
      root: string;
      total: number;
      visible: number;
      modelEnabled: number;
      activeConversations: number;
    };
    computer: AgentComputerStatus;
    subAgent: { enabled: boolean; total: number };
    tool: {
      enabled: boolean;
      total: number;
      mainEnabled: number;
      subAgentEnabled: number;
    };
    trigger: {
      total: number;
      enabled: number;
      scheduled: number;
      passive: number;
    };
  };
  mcp: {
    servers: AgentMcpServerAdmin[];
    tools: AgentMcpToolAdmin[];
  };
  skills: {
    dirs: string[];
    githubTokenConfigured: boolean;
    catalog: AgentSkillAdmin[];
  };
  computer: {
    config: AgentComputerAdminConfig;
    status: AgentComputerStatus;
  };
  subAgents: {
    dirs: string[];
    defaults: AgentSubAgentPermissionConfig;
    catalog: AgentSubAgentAdmin[];
    runs: AgentSubAgentRunAdmin[];
  };
  tools: {
    catalog: AgentToolAdmin[];
  };
  trigger: {
    providers: AgentTriggerProviderAdmin[];
    routingChoices: AgentTriggerRoutingChoice[];
    tasks: AgentTriggerTaskAdmin[];
  };
}
