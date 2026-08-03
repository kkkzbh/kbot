import { z } from 'zod';
import type { AdminToolPolicyState } from '../../types/tool-policy.js';

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

export const agentToolPutSchema = z.object({
  enabled: z.boolean(),
  main: z.boolean(),
}).strict();
export type AgentToolPut = z.infer<typeof agentToolPutSchema>;

export const agentPluginStatePutSchema = z.object({
  enabled: z.boolean(),
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
    defaultProvider: z.enum(['podman', 'e2b', 'open-terminal']),
    idleTimeoutMs: z.number().int().min(10_000).max(86_400_000),
    podman: z.object({
      enabled: z.boolean(),
      image: z.string().trim().min(1).max(1024),
      memoryMb: z.number().int().min(128).max(65_536),
      pidsLimit: z.number().int().min(16).max(32_768),
      commandTimeoutMs: z.number().int().min(1_000).max(3_600_000),
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
}).strict();
export type AgentSkillConfigPut = z.infer<typeof agentSkillConfigPutSchema>;

const toolRouteProfileSchema = z.enum(['agent', 'automation']);
const toolScopeKindSchema = z.enum([
  'global_default',
  'private_default',
  'private_conversation',
  'group',
]);
export const agentToolPolicyPutSchema = z.object({
  overrides: z.array(z.object({
    toolName: z.string().trim().min(1).max(256),
    routeProfile: toolRouteProfileSchema,
    scopeKind: toolScopeKindSchema,
    scopeId: z.string().trim().min(1).max(512),
    enabled: z.boolean(),
  }).strict()).max(4096),
}).strict();
export type AgentToolPolicyPut = z.infer<typeof agentToolPolicyPutSchema>;

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

export interface AgentPodmanComputerConfig {
  enabled: boolean;
  image: string;
  memoryMb: number;
  pidsLimit: number;
  commandTimeoutMs: number;
}

export type AgentComputerCapability =
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
  | 'desktop_action';

export interface AgentComputerBackendStatus {
  type: 'podman' | 'e2b' | 'open-terminal';
  state: 'idle' | 'connecting' | 'connected' | 'error' | 'unsupported';
  error?: string;
  capabilities: AgentComputerCapability[];
  sessionCount: number;
}

export interface AgentComputerStatus {
  enabled: boolean;
  defaultProvider: 'podman' | 'e2b' | 'open-terminal';
  backends: Record<'podman' | 'e2b' | 'open-terminal', AgentComputerBackendStatus>;
  activeSessions: number;
}

export interface AgentComputerAdminConfig {
  defaultProvider: 'podman' | 'e2b' | 'open-terminal';
  idleTimeoutMs: number;
  podman: AgentPodmanComputerConfig;
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

export interface AgentPodmanWorkspace {
  id: string;
  kind: 'group' | 'private' | 'console';
  subjectId: string;
  state: string;
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
  authority: number;
  source?: string;
  group?: string;
  tags?: string[];
  isMcp: boolean;
  serverName?: string;
}

export interface AgentPluginAdmin {
  id: string;
  kind: 'workspace' | 'tool-bundle';
  displayName: string;
  version: string;
  shortDescription: string;
  longDescription: string;
  developerName: string;
  category: string;
  capabilities: string[];
  builtIn: boolean;
  configurable: boolean;
  removable: boolean;
  lockedReason?: string;
  state: 'active' | 'inactive' | 'error';
  contents: {
    mcpServers: string[];
    skills: string[];
    tools: string[];
  };
  computer?: {
    config: AgentComputerAdminConfig;
    status: AgentComputerStatus;
  };
}

export type AgentToolPolicyState = Omit<AdminToolPolicyState, 'conversationTargets'>;

export interface AgentAdminState {
  generatedAt: number;
  version: number;
  mcp: {
    servers: AgentMcpServerAdmin[];
    tools: AgentMcpToolAdmin[];
  };
  skills: {
    dirs: string[];
    githubTokenConfigured: boolean;
    catalog: AgentSkillAdmin[];
  };
  tools: {
    catalog: AgentToolAdmin[];
  };
  plugins: {
    catalog: AgentPluginAdmin[];
  };
}
