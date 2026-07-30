<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  agentComputerConfigPutSchema,
  agentEnabledPutSchema,
  agentMcpServerPutSchema,
  agentMcpToolPutSchema,
  agentSkillContentPutSchema,
  agentSkillConfigPutSchema,
  agentSkillGithubImportSchema,
  agentSkillModePutSchema,
  agentSkillsSettingsPutSchema,
  agentSubAgentInputSchema,
  agentSubAgentSettingsPutSchema,
  agentToolConfigPutSchema,
  agentTriggerTaskInputSchema,
  type AgentAdminState,
  type AgentComputerAdminConfig,
  type AgentMcpServerAdmin,
  type AgentMcpToolAdmin,
  type AgentPermissionRule,
  type AgentSecretUpdate,
  type AgentSkillAdmin,
  type AgentSkillConfigPut,
  type AgentSubAgentAdmin,
  type AgentSubAgentInput,
  type AgentSubAgentPermissionConfig,
  type AgentToolAdmin,
  type AgentToolConfigPut,
  type AgentTriggerTaskAdmin,
} from '@contracts';
import { rawApi, jsonBody, rawJsonBody } from '@/api/client';
import EmptyState from '@/components/EmptyState.vue';

type SectionName =
  | 'overview'
  | 'mcp'
  | 'skills'
  | 'computer'
  | 'sub-agents'
  | 'tools'
  | 'trigger';
type SecretDraft = {
  value: string;
  clear: boolean;
  configured: boolean;
};
type SecretRowDraft = {
  name: string;
  value: string;
  configured: boolean;
};
type McpServerDraft = {
  oldName?: string;
  name: string;
  type: 'stdio' | 'sse' | 'http' | 'streamable_http';
  command: string;
  args: string[];
  url: string;
  timeout: number;
  cwd: string;
  proxy: string;
  env: SecretRowDraft[];
  headers: SecretRowDraft[];
};
type TriggerDraft = {
  id: number | null;
  name: string;
  enabled: boolean;
  providerKind: string;
  routeKey: string;
  platform: string;
  selfId: string;
  isDirect: boolean;
  scope: 'shared' | 'personal';
  userId: string;
  username: string;
  guildId: string;
  channelId: string;
  message: string;
  complexMessage: boolean;
  execMode: 'chain' | 'direct';
  replyTo: 'channel' | 'user' | 'silent' | 'callback';
  newConversation: boolean;
  nextFireAt: string;
  params: string;
  template: Record<string, unknown>;
};

const route = useRoute();
const router = useRouter();
const sections: Array<{ name: SectionName; label: string }> = [
  { name: 'overview', label: '概览' },
  { name: 'mcp', label: 'MCP' },
  { name: 'skills', label: '技能' },
  { name: 'computer', label: '电脑' },
  { name: 'sub-agents', label: 'Sub-Agent' },
  { name: 'tools', label: 'Runtime Tools' },
  { name: 'trigger', label: 'Agent 调度' },
];
const permissionKinds = [
  { key: 'skills', label: 'Skills' },
  { key: 'mcp', label: 'MCP' },
  { key: 'tools', label: 'Runtime Tools' },
  { key: 'computer', label: 'Computer' },
] as const;
const activeSection = ref<SectionName>('overview');
const state = ref<AgentAdminState | null>(null);
const loading = ref(false);
const pending = ref('');
const toolQuery = ref('');
const skillQuery = ref('');
const subAgentQuery = ref('');

const mcpDialogOpen = ref(false);
const mcpDraft = ref<McpServerDraft>(createMcpDraft());
const mcpToolDialogOpen = ref(false);
const mcpToolEditing = ref<AgentMcpToolAdmin | null>(null);
const mcpToolDraft = reactive({ enabled: true, timeout: 0, selector: [] as string[] });

const skillSettingsOpen = ref(false);
const skillDirs = ref<string[]>([]);
const skillToken = reactive<SecretDraft>({ value: '', clear: false, configured: false });
const skillContentOpen = ref(false);
const skillContentId = ref('');
const skillContentName = ref('');
const skillContent = ref('');
const skillConfigOpen = ref(false);
const skillConfigEditing = ref<AgentSkillAdmin | null>(null);
const skillConfigDraft = ref<AgentSkillConfigPut | null>(null);
const skillImportOpen = ref(false);
const skillImportUrl = ref('');

const computerDraft = ref<AgentComputerAdminConfig | null>(null);
const computerE2bKey = reactive<SecretDraft>({ value: '', clear: false, configured: false });
const computerOpenTerminalKey = reactive<SecretDraft>({ value: '', clear: false, configured: false });

const subAgentDialogOpen = ref(false);
const subAgentEditing = ref<AgentSubAgentAdmin | null>(null);
const subAgentDraft = ref<AgentSubAgentInput>(createSubAgentDraft());
const subAgentSettingsOpen = ref(false);
const subAgentDirs = ref<string[]>([]);
const subAgentDefaults = ref<AgentSubAgentPermissionConfig>(createPermissions());

const toolDialogOpen = ref(false);
const toolEditing = ref<AgentToolAdmin | null>(null);
const toolDraft = ref<AgentToolConfigPut | null>(null);

const providerDialogOpen = ref(false);
const triggerDialogOpen = ref(false);
const triggerDraft = ref<TriggerDraft>(createTriggerDraft());

const filteredSkills = computed(() => {
  const query = skillQuery.value.trim().toLowerCase();
  return (state.value?.skills.catalog ?? []).filter((skill) => (
    !query || `${skill.name} ${skill.description} ${skill.id}`.toLowerCase().includes(query)
  ));
});
const filteredSubAgents = computed(() => {
  const query = subAgentQuery.value.trim().toLowerCase();
  return (state.value?.subAgents.catalog ?? []).filter((agent) => (
    !query || `${agent.name} ${agent.description} ${agent.id}`.toLowerCase().includes(query)
  ));
});
const filteredTools = computed(() => {
  const query = toolQuery.value.trim().toLowerCase();
  return (state.value?.tools.catalog ?? []).filter((tool) => (
    !query || `${tool.name} ${tool.description ?? ''} ${tool.source ?? ''} ${tool.group ?? ''}`
      .toLowerCase()
      .includes(query)
  ));
});
const requiredRuntimeToolNames = ['skill', 'file_read', 'bash'] as const;
const runtimeCoreTools = computed(() => requiredRuntimeToolNames.map((name) => ({
  name,
  tool: state.value?.tools.catalog.find((item) => item.name === name) ?? null,
})));
const activeBackend = computed(() => {
  if (!state.value || !computerDraft.value) return null;
  return state.value.computer.status.backends[computerDraft.value.defaultProvider];
});
const computerIdleMinutes = computed({
  get: () => Math.max(1, Math.round((computerDraft.value?.idleTimeoutMs ?? 60_000) / 60_000)),
  set: (minutes: number) => {
    if (computerDraft.value) computerDraft.value.idleTimeoutMs = minutes * 60_000;
  },
});

function createRule(mode: AgentPermissionRule['mode'] = 'inherit'): AgentPermissionRule {
  return { mode, allow: [], deny: [] };
}

function createPermissions(): AgentSubAgentPermissionConfig {
  return {
    skills: createRule(),
    mcp: createRule(),
    tools: createRule(),
    computer: createRule(),
  };
}

function createSubAgentDraft(
  source?: AgentSubAgentAdmin,
  defaults?: AgentSubAgentPermissionConfig,
): AgentSubAgentInput {
  return {
    name: source?.name ?? '',
    description: source?.description ?? '',
    promptContent: source?.promptContent ?? '',
    dedupeTools: source?.dedupeTools ?? false,
    chatluna: source?.chatlunaEnabled ?? true,
    character: source?.characterEnabled ?? true,
    characterGroup: source?.characterGroupEnabled ?? true,
    characterPrivate: source?.characterPrivateEnabled ?? true,
    characterGroupMode: source?.characterGroupMode ?? 'all',
    characterPrivateMode: source?.characterPrivateMode ?? 'all',
    characterGroupIds: [...(source?.characterGroupIds ?? [])],
    characterPrivateIds: [...(source?.characterPrivateIds ?? [])],
    authority: source?.authority ?? 0,
    format: source?.format ?? 'chatluna',
    maxTurns: source?.maxTurns ?? 100,
    hidden: source?.hidden ?? false,
    enabled: source?.enabled ?? true,
    allowKoishiMessageTransform: source?.allowKoishiMessageTransform ?? false,
    permissions: structuredClone(source?.permissions ?? defaults ?? createPermissions()),
  };
}

function createMcpDraft(server?: AgentMcpServerAdmin): McpServerDraft {
  return {
    oldName: server?.name,
    name: server?.name ?? '',
    type: server?.type ?? 'stdio',
    command: server?.command ?? '',
    args: [...(server?.args ?? [])],
    url: server?.url ?? '',
    timeout: server?.timeout ?? 60,
    cwd: server?.cwd ?? '',
    proxy: server?.proxy ?? '',
    env: (server?.envKeys ?? []).map((name) => ({ name, value: '', configured: true })),
    headers: (server?.headerKeys ?? []).map((name) => ({ name, value: '', configured: true })),
  };
}

function createTriggerDraft(task?: AgentTriggerTaskAdmin): TriggerDraft {
  const message = task?.wakeupTemplate.message;
  const complexMessage = Array.isArray(message);
  return {
    id: task?.id ?? null,
    name: task?.name ?? '',
    enabled: task?.enabled ?? true,
    providerKind: task?.providerKind ?? '',
    routeKey: task ? `${task.platform}:${task.selfId}` : '',
    platform: task?.platform ?? '',
    selfId: task?.selfId ?? '',
    isDirect: task?.isDirect ?? false,
    scope: task?.bindingKey.startsWith('shared:') ? 'shared' : 'personal',
    userId: task?.userId ?? '',
    username: task?.username ?? '',
    guildId: task?.guildId ?? '',
    channelId: task?.channelId ?? '',
    message: complexMessage
      ? JSON.stringify(message, null, 2)
      : typeof message === 'string' ? message : '',
    complexMessage,
    execMode: task?.wakeupTemplate.execMode === 'direct' ? 'direct' : 'chain',
    replyTo: task?.wakeupTemplate.replyTo === 'user'
      || task?.wakeupTemplate.replyTo === 'silent'
      || task?.wakeupTemplate.replyTo === 'callback'
      ? task.wakeupTemplate.replyTo
      : 'channel',
    newConversation: Boolean(task?.wakeupTemplate.newConversation),
    nextFireAt: toLocalDateTime(task?.nextFireAt),
    params: JSON.stringify(task?.params ?? {}, null, 2),
    template: structuredClone(task?.wakeupTemplate ?? {}),
  };
}

function toLocalDateTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  const shifted = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function statusType(value?: string): 'success' | 'warning' | 'danger' | 'info' {
  if (value === 'connected' || value === 'ready' || value === 'completed') return 'success';
  if (value === 'connecting' || value === 'reconnecting' || value === 'running') return 'warning';
  if (value === 'error' || value === 'failed' || value === 'invalid') return 'danger';
  return 'info';
}

function secretUpdate(draft: SecretDraft): AgentSecretUpdate {
  if (draft.clear) return { operation: 'clear' };
  if (draft.value) return { operation: 'set', value: draft.value };
  return draft.configured ? { operation: 'keep' } : { operation: 'clear' };
}

function secretRows(rows: SecretRowDraft[]) {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => {
      if (!row.configured && !row.value) {
        throw new Error(`${row.name} 需要填写值。`);
      }
      return {
        name: row.name.trim(),
        update: row.value
          ? { operation: 'set' as const, value: row.value }
          : { operation: 'keep' as const },
      };
    });
}

function path(value: string): string {
  return encodeURIComponent(value);
}

function isBusy(key: string): boolean {
  return pending.value === key;
}

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const result = await rawApi<AgentAdminState>('/agent');
    state.value = result;
    computerDraft.value = structuredClone(result.computer.config);
    Object.assign(computerE2bKey, {
      value: '',
      clear: false,
      configured: result.computer.config.e2b.apiKeyConfigured,
    });
    Object.assign(computerOpenTerminalKey, {
      value: '',
      clear: false,
      configured: result.computer.config.openTerminal.apiKeyConfigured,
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Agent 状态加载失败');
  } finally {
    loading.value = false;
  }
}

async function run(
  key: string,
  action: () => Promise<unknown>,
  success: string,
  reload = true,
): Promise<boolean> {
  if (pending.value) return false;
  pending.value = key;
  try {
    await action();
    if (reload) await loadLatest();
    ElMessage.success(success);
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : `${success}失败`);
    return false;
  } finally {
    pending.value = '';
  }
}

async function loadLatest(): Promise<void> {
  const result = await rawApi<AgentAdminState>('/agent');
  state.value = result;
  computerDraft.value = structuredClone(result.computer.config);
  computerE2bKey.configured = result.computer.config.e2b.apiKeyConfigured;
  computerE2bKey.value = '';
  computerE2bKey.clear = false;
  computerOpenTerminalKey.configured = result.computer.config.openTerminal.apiKeyConfigured;
  computerOpenTerminalKey.value = '';
  computerOpenTerminalKey.clear = false;
}

function openMcp(server?: AgentMcpServerAdmin): void {
  mcpDraft.value = createMcpDraft(server);
  mcpDialogOpen.value = true;
}

function addSecretRow(kind: 'env' | 'headers'): void {
  mcpDraft.value[kind].push({ name: '', value: '', configured: false });
}

async function saveMcp(): Promise<void> {
  try {
    const draft = mcpDraft.value;
    const body = {
      oldName: draft.oldName,
      name: draft.name,
      config: {
        type: draft.type,
        command: draft.type === 'stdio' ? draft.command : undefined,
        args: draft.type === 'stdio' ? draft.args : [],
        url: draft.type === 'stdio' ? undefined : draft.url,
        timeout: draft.timeout,
        cwd: draft.cwd || undefined,
        proxy: draft.proxy || undefined,
        env: secretRows(draft.env),
        headers: draft.type === 'stdio' ? [] : secretRows(draft.headers),
      },
    };
    const ok = await run(
      'mcp-save',
      () => rawApi('/agent/mcp/server', {
        method: 'PUT',
        body: jsonBody(agentMcpServerPutSchema, body),
      }),
      'MCP Server 已保存',
    );
    if (ok) mcpDialogOpen.value = false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'MCP Server 配置无效');
  }
}

async function removeMcp(server: AgentMcpServerAdmin): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 MCP Server「${server.name}」及其连接配置？`,
      '删除 MCP Server',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  await run(
    `mcp-remove:${server.name}`,
    () => rawApi(`/agent/mcp/servers/${path(server.name)}`, { method: 'DELETE' }),
    'MCP Server 已删除',
  );
}

function openMcpTool(tool: AgentMcpToolAdmin): void {
  mcpToolEditing.value = tool;
  Object.assign(mcpToolDraft, {
    enabled: tool.enabled,
    timeout: tool.timeout ?? 0,
    selector: [...tool.selector],
  });
  mcpToolDialogOpen.value = true;
}

async function saveMcpTool(): Promise<void> {
  if (!mcpToolEditing.value) return;
  const name = mcpToolEditing.value.name;
  const body = {
    enabled: mcpToolDraft.enabled,
    timeout: mcpToolDraft.timeout || undefined,
    selector: mcpToolDraft.selector,
  };
  const ok = await run(
    `mcp-tool:${name}`,
    () => rawApi(`/agent/mcp/tools/${path(name)}`, {
      method: 'PUT',
      body: jsonBody(agentMcpToolPutSchema, body),
    }),
    'MCP Tool 已保存',
  );
  if (ok) mcpToolDialogOpen.value = false;
}

function openSkillSettings(): void {
  if (!state.value) return;
  skillDirs.value = [...state.value.skills.dirs];
  Object.assign(skillToken, {
    value: '',
    clear: false,
    configured: state.value.skills.githubTokenConfigured,
  });
  skillSettingsOpen.value = true;
}

async function saveSkillSettings(): Promise<void> {
  const ok = await run(
    'skills-settings',
    () => rawApi('/agent/skills/settings', {
      method: 'PUT',
      body: jsonBody(agentSkillsSettingsPutSchema, {
        dirs: skillDirs.value,
        githubToken: secretUpdate(skillToken),
      }),
    }),
    'Skills 设置已保存',
  );
  if (ok) skillSettingsOpen.value = false;
}

async function saveSkillMode(skill: AgentSkillAdmin, mode: AgentSkillAdmin['mode']): Promise<void> {
  await run(
    `skill-mode:${skill.id}`,
    () => rawApi(`/agent/skills/${path(skill.id)}/mode`, {
      method: 'PUT',
      body: jsonBody(agentSkillModePutSchema, { mode }),
    }),
    `Skill「${skill.name}」已更新`,
  );
}

function openSkillConfig(skill: AgentSkillAdmin): void {
  skillConfigEditing.value = skill;
  skillConfigDraft.value = {
    enabled: skill.enabled,
    mode: skill.mode === 'full' ? 'full' : 'description',
    authority: skill.authority,
    main: skill.main,
    chatluna: skill.chatlunaEnabled,
    character: skill.characterEnabled,
    characterGroup: skill.characterGroupEnabled,
    characterPrivate: skill.characterPrivateEnabled,
    characterGroupMode: skill.characterGroupMode,
    characterPrivateMode: skill.characterPrivateMode,
    characterGroupIds: [...skill.characterGroupIds],
    characterPrivateIds: [...skill.characterPrivateIds],
    subAgents: structuredClone(skill.subAgents),
  };
  skillConfigOpen.value = true;
}

async function saveSkillConfig(): Promise<void> {
  if (!skillConfigEditing.value || !skillConfigDraft.value) return;
  const id = skillConfigEditing.value.id;
  const ok = await run(
    `skill-config:${id}`,
    () => rawApi(`/agent/skills/${path(id)}/config`, {
      method: 'PUT',
      body: jsonBody(agentSkillConfigPutSchema, skillConfigDraft.value),
    }),
    `Skill「${skillConfigEditing.value.name}」权限已保存`,
  );
  if (ok) skillConfigOpen.value = false;
}

async function openSkillContent(skill: AgentSkillAdmin): Promise<void> {
  pending.value = `skill-content:${skill.id}`;
  try {
    const result = await rawApi<{ id: string; content: string }>(
      `/agent/skills/${path(skill.id)}/content`,
    );
    skillContentId.value = result.id;
    skillContentName.value = skill.name;
    skillContent.value = result.content;
    skillContentOpen.value = true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Skill 内容读取失败');
  } finally {
    pending.value = '';
  }
}

async function saveSkillContent(): Promise<void> {
  const ok = await run(
    `skill-content-save:${skillContentId.value}`,
    () => rawApi(`/agent/skills/${path(skillContentId.value)}/content`, {
      method: 'PUT',
      body: jsonBody(agentSkillContentPutSchema, { content: skillContent.value }),
    }),
    'Skill 内容已保存并重载',
  );
  if (ok) skillContentOpen.value = false;
}

async function removeSkill(skill: AgentSkillAdmin): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 Skill「${skill.name}」？`,
      '删除 Skill',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  await run(
    `skill-remove:${skill.id}`,
    () => rawApi(`/agent/skills/${path(skill.id)}`, { method: 'DELETE' }),
    'Skill 已删除',
  );
}

async function importSkill(): Promise<void> {
  const ok = await run(
    'skill-import',
    () => rawApi('/agent/skills/import/github', {
      method: 'POST',
      body: jsonBody(agentSkillGithubImportSchema, { url: skillImportUrl.value }),
    }),
    'Skill 已从 GitHub 导入',
  );
  if (ok) {
    skillImportOpen.value = false;
    skillImportUrl.value = '';
  }
}

async function saveComputer(): Promise<void> {
  if (!computerDraft.value) return;
  const config = structuredClone(computerDraft.value);
  const { apiKeyConfigured: _e2bConfigured, ...e2b } = config.e2b;
  const { apiKeyConfigured: _openTerminalConfigured, ...openTerminal } = config.openTerminal;
  await run(
    'computer-save',
    () => rawApi('/agent/computer', {
      method: 'PUT',
      body: jsonBody(agentComputerConfigPutSchema, {
        config: {
          defaultProvider: config.defaultProvider,
          idleTimeoutMs: config.idleTimeoutMs,
          local: config.local,
          e2b,
          openTerminal,
        },
        e2bApiKey: secretUpdate(computerE2bKey),
        openTerminalApiKey: secretUpdate(computerOpenTerminalKey),
      }),
    }),
    'Computer 配置已保存并重载',
  );
}

async function probeComputer(type: 'local' | 'e2b' | 'open-terminal'): Promise<void> {
  await run(
    `computer-probe:${type}`,
    () => rawApi(`/agent/computer/backends/${type}/probe`, {
      method: 'POST',
      body: rawJsonBody({}),
    }),
    `${type} Backend 探测完成`,
  );
}

function openSubAgent(agent?: AgentSubAgentAdmin): void {
  subAgentEditing.value = agent ?? null;
  subAgentDraft.value = createSubAgentDraft(agent, state.value?.subAgents.defaults);
  subAgentDialogOpen.value = true;
}

async function saveSubAgent(): Promise<void> {
  const editing = subAgentEditing.value;
  const endpoint = editing
    ? `/agent/sub-agents/${path(editing.id)}`
    : '/agent/sub-agents';
  const ok = await run(
    editing ? `sub-agent-save:${editing.id}` : 'sub-agent-create',
    () => rawApi(endpoint, {
      method: editing ? 'PUT' : 'POST',
      body: jsonBody(agentSubAgentInputSchema, subAgentDraft.value),
    }),
    editing ? 'Sub-Agent 已保存' : 'Sub-Agent 已创建',
  );
  if (ok) subAgentDialogOpen.value = false;
}

async function toggleSubAgent(agent: AgentSubAgentAdmin, enabled: boolean): Promise<void> {
  await run(
    `sub-agent-enabled:${agent.id}`,
    () => rawApi(`/agent/sub-agents/${path(agent.id)}/enabled`, {
      method: 'PUT',
      body: jsonBody(agentEnabledPutSchema, { enabled }),
    }),
    `Sub-Agent「${agent.name}」已更新`,
  );
}

async function removeSubAgent(agent: AgentSubAgentAdmin): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 Sub-Agent「${agent.name}」及其项目内定义？`,
      '删除 Sub-Agent',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  await run(
    `sub-agent-remove:${agent.id}`,
    () => rawApi(`/agent/sub-agents/${path(agent.id)}`, { method: 'DELETE' }),
    'Sub-Agent 已删除',
  );
}

function openSubAgentSettings(): void {
  if (!state.value) return;
  subAgentDirs.value = [...state.value.subAgents.dirs];
  subAgentDefaults.value = structuredClone(state.value.subAgents.defaults);
  subAgentSettingsOpen.value = true;
}

async function saveSubAgentSettings(): Promise<void> {
  const ok = await run(
    'sub-agent-settings',
    () => rawApi('/agent/sub-agents/settings', {
      method: 'PUT',
      body: jsonBody(agentSubAgentSettingsPutSchema, {
        dirs: subAgentDirs.value,
        defaults: subAgentDefaults.value,
      }),
    }),
    'Sub-Agent 默认权限已保存',
  );
  if (ok) subAgentSettingsOpen.value = false;
}

function openTool(tool: AgentToolAdmin): void {
  toolEditing.value = tool;
  toolDraft.value = {
    enabled: tool.enabled,
    main: tool.main,
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
  toolDialogOpen.value = true;
}

async function saveTool(): Promise<void> {
  if (!toolEditing.value || !toolDraft.value) return;
  const name = toolEditing.value.name;
  const ok = await run(
    `tool-save:${name}`,
    () => rawApi(`/agent/tools/${path(name)}`, {
      method: 'PUT',
      body: jsonBody(agentToolConfigPutSchema, toolDraft.value),
    }),
    `Runtime Tool「${name}」已保存`,
  );
  if (ok) toolDialogOpen.value = false;
}

async function toggleProvider(kind: string, enabled: boolean): Promise<void> {
  await run(
    `provider:${kind}`,
    () => rawApi(`/agent/trigger/providers/${path(kind)}/enabled`, {
      method: 'PUT',
      body: jsonBody(agentEnabledPutSchema, { enabled }),
    }),
    `调度提供器「${kind}」已更新`,
  );
}

function selectTriggerRoute(routeKey: string): void {
  const routeOption = state.value?.trigger.routingChoices.find(
    (item) => `${item.platform}:${item.selfId}` === routeKey,
  );
  if (!routeOption) return;
  triggerDraft.value.platform = routeOption.platform;
  triggerDraft.value.selfId = routeOption.selfId;
}

function openTrigger(task?: AgentTriggerTaskAdmin): void {
  triggerDraft.value = createTriggerDraft(task);
  triggerDialogOpen.value = true;
}

function triggerBindingKey(draft: TriggerDraft): string {
  if (draft.isDirect) {
    return `personal:${draft.platform}:${draft.selfId}:direct:${draft.userId}`;
  }
  const roomId = draft.guildId || draft.channelId;
  if (draft.scope === 'shared') {
    return `shared:${draft.platform}:${draft.selfId}:${roomId}`;
  }
  return `personal:${draft.platform}:${draft.selfId}:${roomId}:${draft.userId}`;
}

async function saveTrigger(): Promise<void> {
  const draft = triggerDraft.value;
  try {
    const params = JSON.parse(draft.params || '{}');
    if (!params || Array.isArray(params) || typeof params !== 'object') {
      throw new Error('Provider 参数必须是 JSON Object。');
    }
    const message = draft.complexMessage
      ? JSON.parse(draft.message)
      : draft.message;
    const wakeupTemplate = {
      ...draft.template,
      message,
      execMode: draft.execMode,
      replyTo: draft.replyTo,
      newConversation: draft.newConversation,
    };
    const input = {
      providerKind: draft.providerKind || null,
      enabled: draft.enabled,
      name: draft.name || undefined,
      bindingKey: triggerBindingKey(draft),
      selfId: draft.selfId,
      platform: draft.platform,
      userId: draft.userId,
      username: draft.username || undefined,
      guildId: draft.isDirect ? undefined : draft.guildId || undefined,
      channelId: draft.isDirect ? undefined : draft.channelId || draft.guildId || undefined,
      isDirect: draft.isDirect,
      wakeupTemplate,
      params,
      nextFireAt: draft.nextFireAt
        ? new Date(draft.nextFireAt).toISOString()
        : undefined,
    };
    const endpoint = draft.id == null
      ? '/agent/trigger/tasks'
      : `/agent/trigger/tasks/${draft.id}`;
    const ok = await run(
      draft.id == null ? 'trigger-create' : `trigger-save:${draft.id}`,
      () => rawApi(endpoint, {
        method: draft.id == null ? 'POST' : 'PUT',
        body: jsonBody(agentTriggerTaskInputSchema, input),
      }),
      draft.id == null ? 'Agent 调度任务已创建' : 'Agent 调度任务已保存',
    );
    if (ok) triggerDialogOpen.value = false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '调度任务配置无效');
  }
}

async function toggleTrigger(task: AgentTriggerTaskAdmin, enabled: boolean): Promise<void> {
  await run(
    `trigger-enabled:${task.id}`,
    () => rawApi(`/agent/trigger/tasks/${task.id}/enabled`, {
      method: 'PUT',
      body: jsonBody(agentEnabledPutSchema, { enabled }),
    }),
    `调度任务「${task.name || `#${task.id}`}」已更新`,
  );
}

async function fireTrigger(task: AgentTriggerTaskAdmin): Promise<void> {
  await run(
    `trigger-fire:${task.id}`,
    () => rawApi(`/agent/trigger/tasks/${task.id}/fire`, {
      method: 'POST',
      body: rawJsonBody({}),
    }),
    `调度任务「${task.name || `#${task.id}`}」已执行`,
  );
}

async function removeTrigger(task: AgentTriggerTaskAdmin): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除调度任务「${task.name || `#${task.id}`}」？`,
      '删除 Agent 调度任务',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  await run(
    `trigger-remove:${task.id}`,
    () => rawApi(`/agent/trigger/tasks/${task.id}`, { method: 'DELETE' }),
    'Agent 调度任务已删除',
  );
}

function formatTime(value?: number | string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

watch(
  () => route.query.section,
  (value) => {
    if (sections.some((section) => section.name === value)) {
      activeSection.value = value as SectionName;
    }
  },
  { immediate: true },
);
watch(activeSection, (section) => {
  if (route.query.section === section || (section === 'overview' && !route.query.section)) return;
  void router.replace({
    query: {
      ...route.query,
      ...(section === 'overview' ? { section: undefined } : { section }),
    },
  });
});

onMounted(() => void load());
</script>

<template>
  <div class="agent-page" v-loading="loading && !state">
    <header class="agent-heading">
      <div>
        <h1>Agent 能力</h1>
        <p>管理 ChatLuna Agent 的运行时能力、资源与调度。所有操作经 QQBot Admin API 完成。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新状态</el-button>
    </header>

    <template v-if="state">
      <section class="agent-status-strip" aria-label="Agent 运行状态">
        <div>
          <span>MCP</span>
          <strong>{{ state.status.mcp.connectedServers }}/{{ state.status.mcp.serverCount }}</strong>
          <small>Server 在线</small>
        </div>
        <div>
          <span>Skills</span>
          <strong>{{ state.status.skills.modelEnabled }}/{{ state.status.skills.total }}</strong>
          <small>模型可见</small>
        </div>
        <div>
          <span>Computer</span>
          <strong>{{ state.status.computer.activeSessions }}</strong>
          <small>活动会话</small>
        </div>
        <div>
          <span>Sub-Agent</span>
          <strong>{{ state.status.subAgent.total }}</strong>
          <small>已发现</small>
        </div>
        <div>
          <span>Tools</span>
          <strong>{{ state.status.tool.mainEnabled }}/{{ state.status.tool.total }}</strong>
          <small>主 Agent 可用</small>
        </div>
        <div>
          <span>调度</span>
          <strong>{{ state.status.trigger.enabled }}/{{ state.status.trigger.total }}</strong>
          <small>任务启用</small>
        </div>
      </section>

      <nav class="agent-tabs" aria-label="Agent 能力分区">
        <button
          v-for="section in sections"
          :key="section.name"
          :class="{ active: activeSection === section.name }"
          @click="activeSection = section.name"
        >
          {{ section.label }}
        </button>
      </nav>

      <section v-if="activeSection === 'overview'" class="agent-workspace">
        <div class="overview-grid">
          <article class="overview-primary">
            <div class="section-head">
              <div>
                <h2>运行时关键能力</h2>
                <p>启动验证要求 `skill`、`file_read`、`bash` 同时进入 Runtime registry。</p>
              </div>
            </div>
            <div class="capability-list">
              <div v-for="item in runtimeCoreTools" :key="item.name" class="capability-row">
                <code>{{ item.name }}</code>
                <span>{{ item.tool?.description || 'ChatLuna Agent Runtime Tool' }}</span>
                <el-tag
                  :type="item.tool?.enabled && item.tool.main ? 'success' : 'danger'"
                  effect="plain"
                >
                  {{
                    !item.tool
                      ? '未注册'
                      : item.tool.enabled && item.tool.main
                        ? '主 Agent 可用'
                        : '已注册但不可用'
                  }}
                </el-tag>
              </div>
            </div>
          </article>

          <aside class="overview-aside">
            <h2>权限链</h2>
            <ol>
              <li>
                <strong>Runtime registry</strong>
                <span>定义 Agent 能看到和调用哪些工具。</span>
              </li>
              <li>
                <strong>QQBot 工具策略</strong>
                <span>继续按 Route、群聊与私聊范围限制实际调用。</span>
              </li>
            </ol>
            <router-link to="/policies" class="text-link">打开工具策略 →</router-link>
          </aside>
        </div>

        <div class="runtime-summary">
          <article>
            <span>默认 Computer Backend</span>
            <strong>{{ state.computer.config.defaultProvider }}</strong>
            <small>{{ activeBackend?.state ?? 'unknown' }}</small>
          </article>
          <article>
            <span>Skill 根目录</span>
            <strong class="mono summary-path">{{ state.status.skills.root }}</strong>
            <small>{{ state.skills.dirs.length }} 个附加扫描目录</small>
          </article>
          <article>
            <span>配置版本</span>
            <strong>v{{ state.version }}</strong>
            <small>{{ formatTime(state.generatedAt) }} 刷新</small>
          </article>
        </div>
      </section>

      <section v-else-if="activeSection === 'mcp'" class="agent-workspace">
        <div class="section-head">
          <div>
            <h2>MCP Servers</h2>
            <p>Secret 仅显示配置状态；修改时显式选择保留、替换或清除。</p>
          </div>
          <div class="section-actions">
            <el-button
              :loading="isBusy('mcp-reload')"
              @click="run('mcp-reload', () => rawApi('/agent/mcp/reload', { method: 'POST', body: rawJsonBody({}) }), 'MCP 已重载')"
            >
              重载
            </el-button>
            <el-button type="primary" @click="openMcp()">新增 Server</el-button>
          </div>
        </div>
        <div v-if="state.mcp.servers.length" class="record-list">
          <article v-for="server in state.mcp.servers" :key="server.name" class="record-row">
            <div class="record-main">
              <div class="record-title">
                <strong>{{ server.name }}</strong>
                <el-tag :type="statusType(server.status?.state)" effect="plain" size="small">
                  {{ server.status?.stateText || '未连接' }}
                </el-tag>
                <span class="record-kind">{{ server.type }}</span>
              </div>
              <p class="mono">{{ server.type === 'stdio' ? server.command : server.url }}</p>
              <small>
                {{ server.status?.toolCount ?? 0 }} tools
                · {{ server.envKeys.length }} env
                · {{ server.headerKeys.length }} headers
              </small>
            </div>
            <div class="row-actions">
              <el-button
                size="small"
                :loading="isBusy(`mcp-reconnect:${server.name}`)"
                @click="run(`mcp-reconnect:${server.name}`, () => rawApi(`/agent/mcp/servers/${path(server.name)}/reconnect`, { method: 'POST', body: rawJsonBody({}) }), 'MCP Server 已重连')"
              >
                重连
              </el-button>
              <el-button size="small" @click="openMcp(server)">配置</el-button>
              <el-button size="small" type="danger" plain @click="removeMcp(server)">删除</el-button>
            </div>
          </article>
        </div>
        <EmptyState v-else title="尚未配置 MCP Server" />

        <div class="section-head subsection-head">
          <div>
            <h2>MCP Tools</h2>
            <p>工具发现来自已连接的 MCP Server。</p>
          </div>
        </div>
        <el-table v-if="state.mcp.tools.length" :data="state.mcp.tools" class="agent-table">
          <el-table-column prop="name" label="工具" min-width="210">
            <template #default="{ row }">
              <strong>{{ row.title || row.name }}</strong>
              <small class="table-sub mono">{{ row.name }}</small>
            </template>
          </el-table-column>
          <el-table-column prop="server" label="Server" min-width="140" />
          <el-table-column prop="description" label="说明" min-width="280" show-overflow-tooltip />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'" effect="plain" size="small">
                {{ row.enabled ? '启用' : '关闭' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90">
            <template #default="{ row }">
              <el-button text @click="openMcpTool(row)">配置</el-button>
            </template>
          </el-table-column>
        </el-table>
        <EmptyState v-else title="尚未发现 MCP Tool" />
      </section>

      <section v-else-if="activeSection === 'skills'" class="agent-workspace">
        <div class="section-head">
          <div>
            <h2>Skills</h2>
            <p>description 模式只注入目录；full 模式会将 Skill 全文注入模型上下文。</p>
          </div>
          <div class="section-actions">
            <el-input v-model="skillQuery" clearable placeholder="搜索 Skill" class="section-search" />
            <el-button @click="openSkillSettings">扫描设置</el-button>
            <el-button @click="skillImportOpen = true">GitHub 导入</el-button>
            <el-button
              :loading="isBusy('skills-reload')"
              @click="run('skills-reload', () => rawApi('/agent/skills/reload', { method: 'POST', body: rawJsonBody({}) }), 'Skills 已重载')"
            >
              重载
            </el-button>
          </div>
        </div>
        <div v-if="filteredSkills.length" class="record-list">
          <article v-for="skill in filteredSkills" :key="skill.id" class="record-row">
            <div class="record-main">
              <div class="record-title">
                <strong>{{ skill.emoji ? `${skill.emoji} ` : '' }}{{ skill.name }}</strong>
                <el-tag :type="statusType(skill.state)" effect="plain" size="small">
                  {{ skill.state }}
                </el-tag>
                <span class="record-kind">{{ skill.source }} · {{ skill.scope }}</span>
              </div>
              <p>{{ skill.description }}</p>
              <small v-if="skill.diagnostics.length" class="diagnostic">{{ skill.diagnostics.join(' · ') }}</small>
            </div>
            <div class="row-actions">
              <el-select
                :model-value="skill.mode"
                size="small"
                class="mode-select"
                :disabled="Boolean(pending)"
                @change="(mode: AgentSkillAdmin['mode']) => saveSkillMode(skill, mode)"
              >
                <el-option label="关闭" value="off" />
                <el-option label="目录" value="description" />
                <el-option label="全文" value="full" />
              </el-select>
              <el-button
                size="small"
                @click="openSkillConfig(skill)"
              >
                权限
              </el-button>
              <el-button
                size="small"
                :disabled="skill.remote || skill.scope !== 'data'"
                :loading="isBusy(`skill-content:${skill.id}`)"
                @click="openSkillContent(skill)"
              >
                编辑
              </el-button>
              <el-button
                v-if="skill.scope === 'data' || skill.remote"
                size="small"
                type="danger"
                plain
                @click="removeSkill(skill)"
              >
                移除
              </el-button>
            </div>
          </article>
        </div>
        <EmptyState v-else title="没有匹配的 Skill" />
      </section>

      <section v-else-if="activeSection === 'computer' && computerDraft" class="agent-workspace">
        <div class="section-head">
          <div>
            <h2>Computer Runtime</h2>
            <p>这里管理 Agent 的 Computer Backend；管理页不提供交互式终端、桌面远控和任意文件浏览。</p>
          </div>
          <el-button type="primary" :loading="isBusy('computer-save')" @click="saveComputer">
            保存并重载
          </el-button>
        </div>

        <div class="computer-layout">
          <aside class="backend-rail">
            <button
              v-for="(backend, name) in state.computer.status.backends"
              :key="name"
              :class="{ active: computerDraft.defaultProvider === name }"
              @click="computerDraft.defaultProvider = name"
            >
              <span>
                <i class="status-dot" :class="backend.state === 'connected' ? 'ok' : backend.state === 'error' ? 'error' : 'warn'" />
                {{ name }}
              </span>
              <small>{{ backend.state }}</small>
            </button>
          </aside>

          <div class="backend-editor">
            <div class="settings-inline">
              <label>
                <span>默认 Backend</span>
                <el-select v-model="computerDraft.defaultProvider">
                  <el-option label="local" value="local" />
                  <el-option label="e2b" value="e2b" />
                  <el-option label="open-terminal" value="open-terminal" />
                </el-select>
              </label>
              <label>
                <span>会话空闲超时（分钟）</span>
                <el-input-number
                  v-model="computerIdleMinutes"
                  :min="1"
                  :max="1440"
                  :step="1"
                  :controls="false"
                />
              </label>
            </div>

            <template v-if="computerDraft.defaultProvider === 'local'">
              <div class="editor-section-title">
                <div>
                  <h3>Local Backend</h3>
                  <p>将 Agent 限制在明确的 scopePath 与命令策略中。</p>
                </div>
                <el-button size="small" @click="probeComputer('local')">探测</el-button>
              </div>
              <div class="settings-inline">
                <label class="switch-field"><span>启用</span><el-switch v-model="computerDraft.local.enabled" /></label>
                <label>
                  <span>Sandbox</span>
                  <el-select v-model="computerDraft.local.sandboxMode">
                    <el-option label="只读" value="read-only" />
                    <el-option label="工作区可写" value="workspace-write" />
                  </el-select>
                </label>
                <label>
                  <span>Shell</span>
                  <el-select v-model="computerDraft.local.preferredShell">
                    <el-option label="Auto" value="auto" />
                    <el-option label="Git Bash" value="git-bash" />
                    <el-option label="PowerShell" value="powershell" />
                    <el-option label="CMD" value="cmd" />
                  </el-select>
                </label>
                <label>
                  <span>审批模式</span>
                  <el-select v-model="computerDraft.local.approvalMode">
                    <el-option label="按请求" value="on-request" />
                    <el-option label="不审批" value="never" />
                  </el-select>
                </label>
                <label>
                  <span>网络</span>
                  <el-select v-model="computerDraft.local.networkPolicy">
                    <el-option label="阻断" value="block" />
                    <el-option label="允许" value="allow" />
                  </el-select>
                </label>
                <label class="span-2">
                  <span>Scope Path</span>
                  <el-input v-model="computerDraft.local.scopePath" placeholder="/opt/qqbot/app" />
                </label>
                <label>
                  <span>命令超时（毫秒）</span>
                  <el-input-number v-model="computerDraft.local.commandTimeoutMs" :controls="false" :min="1000" />
                </label>
                <label class="switch-field danger-field">
                  <span>跳过权限检查</span>
                  <el-switch v-model="computerDraft.local.dangerouslySkipPermissions" />
                </label>
                <label class="span-2">
                  <span>只读根目录</span>
                  <el-select v-model="computerDraft.local.readOnlyRoots" multiple filterable allow-create default-first-option />
                </label>
                <label class="span-2">
                  <span>拒绝根目录</span>
                  <el-select v-model="computerDraft.local.denyRoots" multiple filterable allow-create default-first-option />
                </label>
                <label class="span-2">
                  <span>允许命令</span>
                  <el-select v-model="computerDraft.local.allowedCommands" multiple filterable allow-create default-first-option />
                </label>
                <label class="span-2">
                  <span>阻断命令</span>
                  <el-select v-model="computerDraft.local.blockedCommands" multiple filterable allow-create default-first-option />
                </label>
                <label class="span-2">
                  <span>忽略路径 Glob</span>
                  <el-select v-model="computerDraft.local.ignores" multiple filterable allow-create default-first-option />
                </label>
              </div>
            </template>

            <template v-else-if="computerDraft.defaultProvider === 'e2b'">
              <div class="editor-section-title">
                <div><h3>E2B Backend</h3><p>隔离云沙箱，支持终端与桌面能力。</p></div>
                <el-button size="small" @click="probeComputer('e2b')">探测</el-button>
              </div>
              <div class="settings-inline">
                <label class="switch-field"><span>启用</span><el-switch v-model="computerDraft.e2b.enabled" /></label>
                <label><span>Template</span><el-input v-model="computerDraft.e2b.template" /></label>
                <label><span>Desktop Template</span><el-input v-model="computerDraft.e2b.desktopTemplate" /></label>
                <label><span>超时（毫秒）</span><el-input-number v-model="computerDraft.e2b.timeoutMs" :controls="false" /></label>
                <label class="switch-field"><span>Keep Alive</span><el-switch v-model="computerDraft.e2b.keepAlive" /></label>
                <label class="span-2">
                  <span>API Key <small>{{ computerDraft.e2b.apiKeyConfigured ? '已配置' : '未配置' }}</small></span>
                  <el-input v-model="computerE2bKey.value" type="password" show-password placeholder="留空保留当前值" />
                  <el-checkbox v-model="computerE2bKey.clear">显式清除</el-checkbox>
                </label>
              </div>
            </template>

            <template v-else>
              <div class="editor-section-title">
                <div><h3>OpenTerminal Backend</h3><p>连接受控的 OpenTerminal 服务。</p></div>
                <el-button size="small" @click="probeComputer('open-terminal')">探测</el-button>
              </div>
              <div class="settings-inline">
                <label class="switch-field"><span>启用</span><el-switch v-model="computerDraft.openTerminal.enabled" /></label>
                <label class="span-2"><span>Base URL</span><el-input v-model="computerDraft.openTerminal.baseUrl" /></label>
                <label>
                  <span>部署模式</span>
                  <el-select v-model="computerDraft.openTerminal.deploymentMode">
                    <el-option label="Docker" value="docker" />
                    <el-option label="Bare metal" value="bare-metal" />
                    <el-option label="未知" value="unknown" />
                  </el-select>
                </label>
                <label class="switch-field"><span>用户隔离</span><el-switch v-model="computerDraft.openTerminal.userIsolation" /></label>
                <label class="span-2">
                  <span>API Key <small>{{ computerDraft.openTerminal.apiKeyConfigured ? '已配置' : '未配置' }}</small></span>
                  <el-input v-model="computerOpenTerminalKey.value" type="password" show-password placeholder="留空保留当前值" />
                  <el-checkbox v-model="computerOpenTerminalKey.clear">显式清除</el-checkbox>
                </label>
              </div>
            </template>
          </div>
        </div>
      </section>

      <section v-else-if="activeSection === 'sub-agents'" class="agent-workspace">
        <div class="section-head">
          <div>
            <h2>Sub-Agent</h2>
            <p>模型绑定继续在“模型配置”维护；这里管理目录、Prompt 与能力权限。</p>
          </div>
          <div class="section-actions">
            <el-input v-model="subAgentQuery" clearable placeholder="搜索 Sub-Agent" class="section-search" />
            <el-button @click="openSubAgentSettings">默认权限</el-button>
            <el-button
              @click="run('sub-agent-reload', () => rawApi('/agent/sub-agents/reload', { method: 'POST', body: rawJsonBody({}) }), 'Sub-Agent 已重载')"
            >
              重载
            </el-button>
            <el-button type="primary" @click="openSubAgent()">新增</el-button>
          </div>
        </div>
        <div v-if="filteredSubAgents.length" class="record-list">
          <article v-for="agent in filteredSubAgents" :key="agent.id" class="record-row">
            <div class="record-main">
              <div class="record-title">
                <strong>{{ agent.name }}</strong>
                <el-tag :type="statusType(agent.state)" effect="plain" size="small">{{ agent.state }}</el-tag>
                <span class="record-kind">{{ agent.source }} · {{ agent.format }}</span>
              </div>
              <p>{{ agent.description }}</p>
              <small>authority {{ agent.authority }} · max {{ agent.maxTurns ?? 100 }} turns</small>
              <small v-if="agent.diagnostics.length" class="diagnostic">{{ agent.diagnostics.join(' · ') }}</small>
            </div>
            <div class="row-actions">
              <el-switch
                :model-value="agent.enabled"
                :loading="isBusy(`sub-agent-enabled:${agent.id}`)"
                @change="(enabled: boolean) => toggleSubAgent(agent, enabled)"
              />
              <el-button
                v-if="agent.source === 'markdown' && !agent.remote"
                size="small"
                @click="openSubAgent(agent)"
              >
                编辑
              </el-button>
              <el-button
                v-if="agent.source !== 'builtin' && agent.source !== 'manual'"
                size="small"
                type="danger"
                plain
                @click="removeSubAgent(agent)"
              >
                删除
              </el-button>
            </div>
          </article>
        </div>
        <EmptyState v-else title="没有匹配的 Sub-Agent" />

        <div class="section-head subsection-head">
          <div><h2>最近运行</h2><p>只展示运行摘要；Prompt、Trace 与输出不会进入管理页聚合响应。</p></div>
        </div>
        <el-table v-if="state.subAgents.runs.length" :data="state.subAgents.runs" class="agent-table">
          <el-table-column prop="agentName" label="Agent" min-width="150" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusType(row.state)" effect="plain" size="small">{{ row.state }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="turnCount" label="Turns" width="80" />
          <el-table-column prop="toolCount" label="Tools" width="80" />
          <el-table-column label="开始" width="150">
            <template #default="{ row }">{{ formatTime(row.startedAt) }}</template>
          </el-table-column>
          <el-table-column prop="error" label="错误" min-width="220" show-overflow-tooltip />
        </el-table>
        <EmptyState v-else title="暂无 Sub-Agent 运行记录" />
      </section>

      <section v-else-if="activeSection === 'tools'" class="agent-workspace">
        <div class="section-head">
          <div>
            <h2>Runtime Tools</h2>
            <p>这里控制 ChatLuna Agent registry；请求仍需通过 QQBot 工具策略的第二道权限检查。</p>
          </div>
          <div class="section-actions">
            <el-input v-model="toolQuery" clearable placeholder="搜索工具" class="section-search" />
            <router-link to="/policies"><el-button>打开工具策略</el-button></router-link>
          </div>
        </div>
        <el-table v-if="filteredTools.length" :data="filteredTools" class="agent-table">
          <el-table-column label="工具" min-width="210">
            <template #default="{ row }">
              <strong>{{ row.name }}</strong>
              <small class="table-sub">{{ row.group || row.source || 'runtime' }}</small>
            </template>
          </el-table-column>
          <el-table-column prop="description" label="说明" min-width="280" show-overflow-tooltip />
          <el-table-column label="全局" width="80">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'" effect="plain" size="small">
                {{ row.enabled ? '开' : '关' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="主 Agent" width="90">
            <template #default="{ row }">{{ row.main ? '允许' : '禁止' }}</template>
          </el-table-column>
          <el-table-column label="ChatLuna" width="90">
            <template #default="{ row }">{{ row.chatlunaEnabled ? '允许' : '禁止' }}</template>
          </el-table-column>
          <el-table-column prop="authority" label="权限级" width="80" />
          <el-table-column label="操作" width="90">
            <template #default="{ row }"><el-button text @click="openTool(row)">配置</el-button></template>
          </el-table-column>
        </el-table>
        <EmptyState v-else title="没有匹配的 Runtime Tool" />
      </section>

      <section v-else-if="activeSection === 'trigger'" class="agent-workspace">
        <div class="section-head">
          <div>
            <h2>Agent 调度</h2>
            <p>ChatLuna Agent Trigger 负责定时和被动唤醒；QQBot“自然触发”继续管理消息应答判定。</p>
          </div>
          <div class="section-actions">
            <el-button @click="providerDialogOpen = true">提供器</el-button>
            <el-button type="primary" @click="openTrigger()">新增任务</el-button>
          </div>
        </div>
        <div v-if="state.trigger.tasks.length" class="record-list">
          <article v-for="task in state.trigger.tasks" :key="task.id" class="record-row">
            <div class="record-main">
              <div class="record-title">
                <strong>{{ task.name || `任务 #${task.id}` }}</strong>
                <el-tag :type="task.enabled ? 'success' : 'info'" effect="plain" size="small">
                  {{ task.enabled ? '启用' : '暂停' }}
                </el-tag>
                <span class="record-kind">{{ task.providerKind || 'once' }}</span>
              </div>
              <p>{{ typeof task.wakeupTemplate.message === 'string' ? task.wakeupTemplate.message : '结构化消息' }}</p>
              <small>
                {{ task.platform }}:{{ task.selfId }}
                · 下次 {{ formatTime(task.nextFireAt) }}
                · 已执行 {{ task.fireCount }} 次
              </small>
              <small v-if="task.lastError" class="diagnostic">{{ task.lastError }}</small>
            </div>
            <div class="row-actions">
              <el-switch
                :model-value="task.enabled"
                :loading="isBusy(`trigger-enabled:${task.id}`)"
                @change="(enabled: boolean) => toggleTrigger(task, enabled)"
              />
              <el-button size="small" @click="fireTrigger(task)">立即执行</el-button>
              <el-button size="small" @click="openTrigger(task)">编辑</el-button>
              <el-button size="small" type="danger" plain @click="removeTrigger(task)">删除</el-button>
            </div>
          </article>
        </div>
        <EmptyState v-else title="尚未创建 Agent 调度任务" />
      </section>
    </template>

    <el-dialog v-model="mcpDialogOpen" :title="mcpDraft.oldName ? '配置 MCP Server' : '新增 MCP Server'" width="min(760px, calc(100vw - 32px))" destroy-on-close>
      <el-form label-position="top">
        <div class="dialog-grid">
          <el-form-item label="名称"><el-input v-model="mcpDraft.name" /></el-form-item>
          <el-form-item label="Transport">
            <el-select v-model="mcpDraft.type">
              <el-option label="stdio" value="stdio" />
              <el-option label="HTTP" value="http" />
              <el-option label="Streamable HTTP" value="streamable_http" />
              <el-option label="SSE" value="sse" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="mcpDraft.type === 'stdio'" label="Command">
            <el-input v-model="mcpDraft.command" />
          </el-form-item>
          <el-form-item v-else label="URL"><el-input v-model="mcpDraft.url" /></el-form-item>
          <el-form-item v-if="mcpDraft.type === 'stdio'" label="Args">
            <el-select v-model="mcpDraft.args" multiple filterable allow-create default-first-option />
          </el-form-item>
          <el-form-item label="Timeout（秒）">
            <el-input-number v-model="mcpDraft.timeout" :controls="false" :min="1" :max="600" />
          </el-form-item>
          <el-form-item label="Working Directory"><el-input v-model="mcpDraft.cwd" /></el-form-item>
          <el-form-item label="Proxy"><el-input v-model="mcpDraft.proxy" /></el-form-item>
        </div>
        <div class="secret-editor">
          <div class="secret-head"><strong>环境变量</strong><el-button text @click="addSecretRow('env')">添加</el-button></div>
          <div v-for="(row, index) in mcpDraft.env" :key="index" class="secret-row">
            <el-input v-model="row.name" placeholder="NAME" />
            <el-input v-model="row.value" type="password" show-password :placeholder="row.configured ? '留空保留当前值' : 'Secret value'" />
            <el-button text type="danger" @click="mcpDraft.env.splice(index, 1)">移除</el-button>
          </div>
        </div>
        <div v-if="mcpDraft.type !== 'stdio'" class="secret-editor">
          <div class="secret-head"><strong>HTTP Headers</strong><el-button text @click="addSecretRow('headers')">添加</el-button></div>
          <div v-for="(row, index) in mcpDraft.headers" :key="index" class="secret-row">
            <el-input v-model="row.name" placeholder="Authorization" />
            <el-input v-model="row.value" type="password" show-password :placeholder="row.configured ? '留空保留当前值' : 'Header value'" />
            <el-button text type="danger" @click="mcpDraft.headers.splice(index, 1)">移除</el-button>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="mcpDialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="isBusy('mcp-save')" @click="saveMcp">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mcpToolDialogOpen" :title="`MCP Tool · ${mcpToolEditing?.name || ''}`" width="min(560px, calc(100vw - 32px))">
      <el-form label-position="top">
        <el-form-item label="启用"><el-switch v-model="mcpToolDraft.enabled" /></el-form-item>
        <el-form-item label="超时（秒，0 表示继承 Server）">
          <el-input-number v-model="mcpToolDraft.timeout" :controls="false" :min="0" :max="600" />
        </el-form-item>
        <el-form-item label="Selector">
          <el-select v-model="mcpToolDraft.selector" multiple filterable allow-create default-first-option />
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="mcpToolDialogOpen = false">取消</el-button><el-button type="primary" @click="saveMcpTool">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="skillSettingsOpen" title="Skills 扫描设置" width="min(620px, calc(100vw - 32px))">
      <el-form label-position="top">
        <el-form-item label="附加目录"><el-select v-model="skillDirs" multiple filterable allow-create default-first-option /></el-form-item>
        <el-form-item :label="`GitHub Token · ${skillToken.configured ? '已配置' : '未配置'}`">
          <el-input v-model="skillToken.value" type="password" show-password placeholder="留空保留当前值" />
          <el-checkbox v-model="skillToken.clear">显式清除</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="skillSettingsOpen = false">取消</el-button><el-button type="primary" @click="saveSkillSettings">保存</el-button></template>
    </el-dialog>

    <el-dialog
      v-model="skillConfigOpen"
      :title="`Skill 权限 · ${skillConfigEditing?.name || ''}`"
      width="min(760px, calc(100vw - 32px))"
    >
      <template v-if="skillConfigDraft">
        <div class="toggle-line">
          <label><span>启用</span><el-switch v-model="skillConfigDraft.enabled" /></label>
          <label><span>主 Agent</span><el-switch v-model="skillConfigDraft.main" /></label>
          <label><span>ChatLuna</span><el-switch v-model="skillConfigDraft.chatluna" /></label>
          <label><span>Character</span><el-switch v-model="skillConfigDraft.character" /></label>
          <label><span>Character 群聊</span><el-switch v-model="skillConfigDraft.characterGroup" /></label>
          <label><span>Character 私聊</span><el-switch v-model="skillConfigDraft.characterPrivate" /></label>
        </div>
        <div class="dialog-grid top-gap">
          <el-form-item label="注入模式">
            <el-select v-model="skillConfigDraft.mode">
              <el-option label="描述目录" value="description" />
              <el-option label="全文" value="full" />
            </el-select>
          </el-form-item>
          <el-form-item label="Authority">
            <el-input-number v-model="skillConfigDraft.authority" :min="0" :max="5" :controls="false" />
          </el-form-item>
          <el-form-item label="Sub-Agent 规则">
            <el-select v-model="skillConfigDraft.subAgents.mode">
              <el-option label="继承" value="inherit" />
              <el-option label="全部" value="all" />
              <el-option label="白名单" value="allow" />
              <el-option label="黑名单" value="deny" />
            </el-select>
          </el-form-item>
          <el-form-item
            v-if="skillConfigDraft.subAgents.mode === 'allow'"
            label="允许的 Sub-Agent"
          >
            <el-select v-model="skillConfigDraft.subAgents.allow" multiple filterable allow-create default-first-option />
          </el-form-item>
          <el-form-item
            v-else-if="skillConfigDraft.subAgents.mode === 'deny'"
            label="拒绝的 Sub-Agent"
          >
            <el-select v-model="skillConfigDraft.subAgents.deny" multiple filterable allow-create default-first-option />
          </el-form-item>
          <el-form-item label="Character 群聊模式">
            <el-select v-model="skillConfigDraft.characterGroupMode">
              <el-option label="全部" value="all" />
              <el-option label="白名单" value="allow" />
              <el-option label="黑名单" value="deny" />
            </el-select>
          </el-form-item>
          <el-form-item label="Character 私聊模式">
            <el-select v-model="skillConfigDraft.characterPrivateMode">
              <el-option label="全部" value="all" />
              <el-option label="白名单" value="allow" />
              <el-option label="黑名单" value="deny" />
            </el-select>
          </el-form-item>
          <el-form-item class="span-2" label="Character 群 ID">
            <el-select v-model="skillConfigDraft.characterGroupIds" multiple filterable allow-create default-first-option />
          </el-form-item>
          <el-form-item class="span-2" label="Character 用户 ID">
            <el-select v-model="skillConfigDraft.characterPrivateIds" multiple filterable allow-create default-first-option />
          </el-form-item>
        </div>
      </template>
      <template #footer>
        <el-button @click="skillConfigOpen = false">取消</el-button>
        <el-button type="primary" :loading="Boolean(skillConfigEditing && isBusy(`skill-config:${skillConfigEditing.id}`))" @click="saveSkillConfig">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="skillContentOpen" :title="`编辑 Skill · ${skillContentName}`" width="min(900px, calc(100vw - 32px))">
      <el-input v-model="skillContent" type="textarea" :rows="24" class="code-textarea" />
      <template #footer><el-button @click="skillContentOpen = false">取消</el-button><el-button type="primary" @click="saveSkillContent">保存并重载</el-button></template>
    </el-dialog>

    <el-dialog v-model="skillImportOpen" title="从 GitHub 导入 Skill" width="min(620px, calc(100vw - 32px))">
      <el-form label-position="top">
        <el-form-item label="Repository 或子目录 URL">
          <el-input v-model="skillImportUrl" placeholder="https://github.com/owner/repo/tree/main/skills/example" />
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="skillImportOpen = false">取消</el-button><el-button type="primary" @click="importSkill">导入</el-button></template>
    </el-dialog>

    <el-dialog v-model="subAgentDialogOpen" :title="subAgentEditing ? `编辑 Sub-Agent · ${subAgentEditing.name}` : '新增 Sub-Agent'" width="min(920px, calc(100vw - 32px))" destroy-on-close>
      <el-form label-position="top">
        <div class="dialog-grid">
          <el-form-item label="名称"><el-input v-model="subAgentDraft.name" /></el-form-item>
          <el-form-item label="格式">
            <el-select v-model="subAgentDraft.format"><el-option label="ChatLuna" value="chatluna" /><el-option label="Claude" value="claude" /><el-option label="OpenCode" value="opencode" /></el-select>
          </el-form-item>
          <el-form-item class="span-2" label="说明"><el-input v-model="subAgentDraft.description" /></el-form-item>
          <el-form-item label="最大 Turns"><el-input-number v-model="subAgentDraft.maxTurns" :min="1" :max="1000" :controls="false" /></el-form-item>
          <el-form-item label="Authority"><el-input-number v-model="subAgentDraft.authority" :min="0" :max="5" :controls="false" /></el-form-item>
          <el-form-item class="span-2" label="Prompt"><el-input v-model="subAgentDraft.promptContent" type="textarea" :rows="13" class="code-textarea" /></el-form-item>
        </div>
        <div class="toggle-line">
          <label><span>启用</span><el-switch v-model="subAgentDraft.enabled" /></label>
          <label><span>ChatLuna</span><el-switch v-model="subAgentDraft.chatluna" /></label>
          <label><span>Character</span><el-switch v-model="subAgentDraft.character" /></label>
          <label><span>Character 群聊</span><el-switch v-model="subAgentDraft.characterGroup" /></label>
          <label><span>Character 私聊</span><el-switch v-model="subAgentDraft.characterPrivate" /></label>
          <label><span>工具去重</span><el-switch v-model="subAgentDraft.dedupeTools" /></label>
          <label><span>隐藏</span><el-switch v-model="subAgentDraft.hidden" /></label>
          <label><span>Koishi 消息转换</span><el-switch v-model="subAgentDraft.allowKoishiMessageTransform" /></label>
        </div>
        <h3 class="dialog-section-title">能力权限</h3>
        <div class="permission-grid">
          <div v-for="item in permissionKinds" :key="item.key" class="permission-row">
            <strong>{{ item.label }}</strong>
            <el-select v-model="subAgentDraft.permissions[item.key].mode">
              <el-option label="继承" value="inherit" /><el-option label="全部" value="all" /><el-option label="白名单" value="allow" /><el-option label="黑名单" value="deny" />
            </el-select>
            <el-select v-if="subAgentDraft.permissions[item.key].mode === 'allow'" v-model="subAgentDraft.permissions[item.key].allow" multiple filterable allow-create default-first-option placeholder="允许项" />
            <el-select v-else-if="subAgentDraft.permissions[item.key].mode === 'deny'" v-model="subAgentDraft.permissions[item.key].deny" multiple filterable allow-create default-first-option placeholder="拒绝项" />
            <span v-else class="permission-empty">无需填写列表</span>
          </div>
        </div>
      </el-form>
      <template #footer><el-button @click="subAgentDialogOpen = false">取消</el-button><el-button type="primary" @click="saveSubAgent">{{ subAgentEditing ? '保存' : '创建' }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="subAgentSettingsOpen" title="Sub-Agent 默认权限" width="min(760px, calc(100vw - 32px))">
      <el-form label-position="top">
        <el-form-item label="附加目录"><el-select v-model="subAgentDirs" multiple filterable allow-create default-first-option /></el-form-item>
        <div class="permission-grid">
          <div v-for="item in permissionKinds" :key="item.key" class="permission-row">
            <strong>{{ item.label }}</strong>
            <el-select v-model="subAgentDefaults[item.key].mode">
              <el-option label="继承" value="inherit" /><el-option label="全部" value="all" /><el-option label="白名单" value="allow" /><el-option label="黑名单" value="deny" />
            </el-select>
            <el-select v-if="subAgentDefaults[item.key].mode === 'allow'" v-model="subAgentDefaults[item.key].allow" multiple filterable allow-create default-first-option placeholder="允许项" />
            <el-select v-else-if="subAgentDefaults[item.key].mode === 'deny'" v-model="subAgentDefaults[item.key].deny" multiple filterable allow-create default-first-option placeholder="拒绝项" />
            <span v-else class="permission-empty">无需填写列表</span>
          </div>
        </div>
      </el-form>
      <template #footer><el-button @click="subAgentSettingsOpen = false">取消</el-button><el-button type="primary" @click="saveSubAgentSettings">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="toolDialogOpen" :title="`Runtime Tool · ${toolEditing?.name || ''}`" width="min(760px, calc(100vw - 32px))">
      <template v-if="toolDraft">
        <div class="toggle-line">
          <label><span>全局启用</span><el-switch v-model="toolDraft.enabled" /></label>
          <label><span>主 Agent</span><el-switch v-model="toolDraft.main" /></label>
          <label><span>ChatLuna</span><el-switch v-model="toolDraft.chatluna" /></label>
          <label><span>Character</span><el-switch v-model="toolDraft.character" /></label>
          <label><span>Character 群聊</span><el-switch v-model="toolDraft.characterGroup" /></label>
          <label><span>Character 私聊</span><el-switch v-model="toolDraft.characterPrivate" /></label>
        </div>
        <div class="dialog-grid top-gap">
          <el-form-item label="Authority"><el-input-number v-model="toolDraft.authority" :min="0" :max="5" :controls="false" /></el-form-item>
          <el-form-item label="Sub-Agent 规则">
            <el-select v-model="toolDraft.subAgents.mode">
              <el-option label="继承" value="inherit" /><el-option label="全部" value="all" /><el-option label="白名单" value="allow" /><el-option label="黑名单" value="deny" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="toolDraft.subAgents.mode === 'allow'" class="span-2" label="允许的 Sub-Agent">
            <el-select v-model="toolDraft.subAgents.allow" multiple filterable allow-create default-first-option />
          </el-form-item>
          <el-form-item v-if="toolDraft.subAgents.mode === 'deny'" class="span-2" label="拒绝的 Sub-Agent">
            <el-select v-model="toolDraft.subAgents.deny" multiple filterable allow-create default-first-option />
          </el-form-item>
          <el-form-item label="Character 群聊模式">
            <el-select v-model="toolDraft.characterGroupMode"><el-option label="全部" value="all" /><el-option label="白名单" value="allow" /><el-option label="黑名单" value="deny" /></el-select>
          </el-form-item>
          <el-form-item label="Character 私聊模式">
            <el-select v-model="toolDraft.characterPrivateMode"><el-option label="全部" value="all" /><el-option label="白名单" value="allow" /><el-option label="黑名单" value="deny" /></el-select>
          </el-form-item>
          <el-form-item class="span-2" label="Character 群 ID"><el-select v-model="toolDraft.characterGroupIds" multiple filterable allow-create default-first-option /></el-form-item>
          <el-form-item class="span-2" label="Character 用户 ID"><el-select v-model="toolDraft.characterPrivateIds" multiple filterable allow-create default-first-option /></el-form-item>
        </div>
      </template>
      <template #footer><el-button @click="toolDialogOpen = false">取消</el-button><el-button type="primary" @click="saveTool">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="providerDialogOpen" title="Agent 调度提供器" width="min(640px, calc(100vw - 32px))">
      <div class="provider-list">
        <div v-for="provider in state?.trigger.providers" :key="provider.kind">
          <div>
            <strong>{{ provider.name }} <code>{{ provider.kind }}</code></strong>
            <p>{{ provider.description }}</p>
          </div>
          <el-switch :model-value="provider.enabled !== false" @change="(enabled: boolean) => toggleProvider(provider.kind, enabled)" />
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="triggerDialogOpen" :title="triggerDraft.id == null ? '新增 Agent 调度任务' : '编辑 Agent 调度任务'" width="min(880px, calc(100vw - 32px))" destroy-on-close>
      <el-form label-position="top">
        <div class="dialog-grid">
          <el-form-item label="名称"><el-input v-model="triggerDraft.name" /></el-form-item>
          <el-form-item label="Provider">
            <el-select v-model="triggerDraft.providerKind" clearable>
              <el-option v-for="provider in state?.trigger.providers" :key="provider.kind" :label="provider.name" :value="provider.kind" :disabled="provider.enabled === false" />
            </el-select>
          </el-form-item>
          <el-form-item label="机器人">
            <el-select v-model="triggerDraft.routeKey" clearable filterable @change="selectTriggerRoute">
              <el-option v-for="item in state?.trigger.routingChoices" :key="`${item.platform}:${item.selfId}`" :label="item.label" :value="`${item.platform}:${item.selfId}`" />
            </el-select>
          </el-form-item>
          <el-form-item label="会话类型"><el-switch v-model="triggerDraft.isDirect" active-text="私聊" inactive-text="群聊" /></el-form-item>
          <el-form-item label="Platform"><el-input v-model="triggerDraft.platform" /></el-form-item>
          <el-form-item label="Bot Self ID"><el-input v-model="triggerDraft.selfId" /></el-form-item>
          <el-form-item label="User ID"><el-input v-model="triggerDraft.userId" /></el-form-item>
          <el-form-item v-if="!triggerDraft.isDirect" label="群 ID"><el-input v-model="triggerDraft.guildId" /></el-form-item>
          <el-form-item v-if="!triggerDraft.isDirect" label="频道 ID"><el-input v-model="triggerDraft.channelId" /></el-form-item>
          <el-form-item v-if="!triggerDraft.isDirect" label="群作用域">
            <el-radio-group v-model="triggerDraft.scope"><el-radio-button value="shared">整个群</el-radio-button><el-radio-button value="personal">指定用户</el-radio-button></el-radio-group>
          </el-form-item>
          <el-form-item label="下次执行时间"><el-input v-model="triggerDraft.nextFireAt" type="datetime-local" /></el-form-item>
          <el-form-item label="执行模式"><el-radio-group v-model="triggerDraft.execMode"><el-radio-button value="chain">Chain</el-radio-button><el-radio-button value="direct">Direct</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="回复位置"><el-select v-model="triggerDraft.replyTo"><el-option label="频道" value="channel" /><el-option label="用户" value="user" /><el-option label="静默" value="silent" /><el-option label="回调" value="callback" /></el-select></el-form-item>
          <el-form-item label="新会话"><el-switch v-model="triggerDraft.newConversation" /></el-form-item>
          <el-form-item class="span-2" label="唤醒消息">
            <el-input v-model="triggerDraft.message" type="textarea" :rows="6" />
            <el-checkbox v-model="triggerDraft.complexMessage">按 JSON 结构化消息解析</el-checkbox>
          </el-form-item>
          <el-form-item class="span-2" label="Provider 参数（JSON Object）"><el-input v-model="triggerDraft.params" type="textarea" :rows="7" class="code-textarea" /></el-form-item>
          <el-form-item label="启用"><el-switch v-model="triggerDraft.enabled" /></el-form-item>
        </div>
      </el-form>
      <template #footer><el-button @click="triggerDialogOpen = false">取消</el-button><el-button type="primary" @click="saveTrigger">{{ triggerDraft.id == null ? '创建' : '保存' }}</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.agent-page{min-width:0}
.agent-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:20px}
.agent-heading h1{margin:0;color:var(--ink);font-size:24px;line-height:1.2;letter-spacing:-.025em}
.agent-heading p{max-width:760px;margin:7px 0 0;color:var(--muted);font-size:12px;line-height:1.65}
.agent-status-strip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));overflow:hidden;margin-bottom:18px;border:1px solid var(--line);border-radius:12px;background:#fff}
.agent-status-strip>div{min-width:0;padding:15px 17px;border-right:1px solid var(--line)}
.agent-status-strip>div:last-child{border-right:0}
.agent-status-strip span,.agent-status-strip small{display:block;color:#8a94a4;font-size:10px}
.agent-status-strip strong{display:block;margin:5px 0 3px;color:var(--ink);font-size:21px;font-weight:680;letter-spacing:-.04em}
.agent-tabs{display:flex;gap:3px;overflow-x:auto;margin-bottom:0;padding:0 7px;border:1px solid var(--line);border-bottom:0;border-radius:12px 12px 0 0;background:#f8fafc}
.agent-tabs button{position:relative;flex:none;padding:13px 12px 11px;border:0;color:#748096;background:transparent;font-size:12px}
.agent-tabs button::after{content:"";position:absolute;right:12px;bottom:0;left:12px;height:2px;border-radius:2px;background:transparent}
.agent-tabs button.active{color:#315abd;font-weight:650}
.agent-tabs button.active::after{background:var(--accent)}
.agent-workspace{min-height:420px;padding:0 20px 24px;border:1px solid var(--line);border-radius:0 0 12px 12px;background:#fff}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:68px;padding:14px 0;border-bottom:1px solid var(--line)}
.section-head h2,.overview-primary h2,.overview-aside h2{margin:0;color:var(--ink);font-size:14px}
.section-head p,.editor-section-title p{margin:4px 0 0;color:var(--muted);font-size:11px;line-height:1.55}
.section-actions,.row-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.section-search{width:190px}
.subsection-head{margin-top:18px}
.overview-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,.7fr);gap:28px;padding:24px 0 4px}
.overview-primary{min-width:0}
.overview-aside{padding-left:24px;border-left:1px solid var(--line)}
.overview-aside ol{display:grid;gap:17px;margin:18px 0;padding:0;list-style:none;counter-reset:step}
.overview-aside li{position:relative;padding-left:29px;counter-increment:step}
.overview-aside li::before{content:counter(step);position:absolute;top:0;left:0;width:19px;height:19px;display:grid;place-items:center;border-radius:50%;color:#4068cf;background:#edf2ff;font-size:10px;font-weight:700}
.overview-aside strong,.overview-aside span{display:block}
.overview-aside strong{font-size:12px}
.overview-aside span{margin-top:3px;color:var(--muted);font-size:11px;line-height:1.55}
.text-link{color:#315abd;font-size:11px;font-weight:650}
.capability-list,.record-list{display:grid}
.capability-row,.record-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:15px 0;border-bottom:1px solid #edf0f4}
.capability-row:last-child,.record-row:last-child{border-bottom:0}
.capability-row code{min-width:100px;color:#315abd;font-size:12px;font-weight:700}
.capability-row>span{flex:1;min-width:0;color:#697386;font-size:11px}
.runtime-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;margin-top:22px;border-top:1px solid var(--line)}
.runtime-summary article{min-width:0;padding:20px 20px 0 0}
.runtime-summary span,.runtime-summary small{display:block;color:var(--muted);font-size:10px}
.runtime-summary strong{display:block;margin:7px 0 4px;font-size:15px}
.summary-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.record-main{min-width:0;flex:1}
.record-title{display:flex;align-items:center;gap:8px;min-width:0}
.record-title strong{overflow:hidden;color:var(--ink);font-size:13px;text-overflow:ellipsis;white-space:nowrap}
.record-kind{color:#9099a7;font-size:10px;text-transform:none}
.record-main p{overflow:hidden;max-width:900px;margin:6px 0 4px;color:#626d7f;font-size:11px;line-height:1.55;text-overflow:ellipsis}
.record-main small{color:#9099a7;font-size:10px}
.record-main .diagnostic{display:block;margin-top:4px;color:#b36139}
.mode-select{width:100px}
.table-sub{display:block;margin-top:2px;color:#929cab;font-size:9px}
.agent-table{margin-top:14px}
.computer-layout{display:grid;grid-template-columns:190px minmax(0,1fr);min-height:480px}
.backend-rail{padding:16px 15px 0 0;border-right:1px solid var(--line)}
.backend-rail button{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px;padding:10px;border:0;border-radius:8px;color:#657083;background:transparent;text-align:left;font-size:11px}
.backend-rail button span{display:flex;align-items:center;gap:8px}
.backend-rail button small{color:#9aa3b0;font-size:9px}
.backend-rail button.active{color:#315abd;background:#edf2ff;font-weight:650}
.backend-editor{min-width:0;padding:22px 0 0 24px}
.settings-inline,.dialog-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 18px}
.settings-inline label{display:grid;align-content:start;gap:7px;min-width:0;color:#515b6c;font-size:11px}
.settings-inline label>span{font-weight:600}
.settings-inline label small{margin-left:4px;color:#929baa;font-weight:400}
.settings-inline .span-2,.dialog-grid .span-2{grid-column:1/-1}
.switch-field{grid-template-columns:1fr auto;align-items:center;padding:12px 13px;border:1px solid var(--line);border-radius:9px}
.danger-field{color:#9c4b57;background:#fffafa}
.editor-section-title{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:25px 0 17px;padding-top:20px;border-top:1px solid var(--line)}
.editor-section-title h3{margin:0;font-size:13px}
.secret-editor{margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.secret-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:12px}
.secret-row{display:grid;grid-template-columns:1fr 1.4fr auto;gap:8px;margin-top:8px}
.code-textarea :deep(textarea){font-family:"SFMono-Regular",Consolas,monospace;font-size:11px;line-height:1.6}
.toggle-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.toggle-line label{display:flex;align-items:center;justify-content:space-between;gap:14px;min-width:128px;padding:10px 12px;border:1px solid var(--line);border-radius:9px;color:#596274;font-size:11px}
.dialog-section-title{margin:22px 0 10px;font-size:13px}
.permission-grid{display:grid;gap:8px}
.permission-row{display:grid;grid-template-columns:110px 130px minmax(0,1fr);align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #edf0f4}
.permission-row strong{font-size:11px}
.permission-empty{color:#9aa3b0;font-size:10px}
.top-gap{margin-top:18px}
.provider-list{display:grid}
.provider-list>div{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 0;border-bottom:1px solid var(--line)}
.provider-list>div:last-child{border-bottom:0}
.provider-list strong{font-size:12px}
.provider-list code{margin-left:5px;color:#6f7a8c;font-size:10px}
.provider-list p{margin:4px 0 0;color:var(--muted);font-size:10px;line-height:1.5}
@media(max-width:1100px){
  .agent-status-strip{grid-template-columns:repeat(3,minmax(0,1fr))}
  .agent-status-strip>div:nth-child(3){border-right:0}
  .agent-status-strip>div:nth-child(-n+3){border-bottom:1px solid var(--line)}
  .overview-grid{grid-template-columns:1fr}
  .overview-aside{padding:20px 0 0;border-top:1px solid var(--line);border-left:0}
}
@media(max-width:760px){
  .agent-heading,.section-head,.record-row{align-items:flex-start;flex-direction:column}
  .agent-status-strip{grid-template-columns:repeat(2,minmax(0,1fr))}
  .agent-status-strip>div:nth-child(3){border-right:1px solid var(--line)}
  .agent-status-strip>div:nth-child(even){border-right:0}
  .agent-status-strip>div:nth-child(-n+4){border-bottom:1px solid var(--line)}
  .agent-tabs{margin-inline:-1px}
  .agent-workspace{padding-inline:14px}
  .section-actions,.section-search{width:100%}
  .row-actions{width:100%;justify-content:flex-end}
  .runtime-summary,.settings-inline,.dialog-grid{grid-template-columns:1fr}
  .settings-inline .span-2,.dialog-grid .span-2{grid-column:auto}
  .computer-layout{grid-template-columns:1fr}
  .backend-rail{display:flex;gap:5px;overflow-x:auto;padding:12px 0;border-right:0;border-bottom:1px solid var(--line)}
  .backend-rail button{flex:0 0 150px}
  .backend-editor{padding-left:0}
  .permission-row{grid-template-columns:1fr}
  .secret-row{grid-template-columns:1fr}
}
</style>
