<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  toRaw,
  watch,
} from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  ChevronRight,
  Monitor,
  RotateCw,
  Server,
  Sparkles,
  Wrench,
} from '@lucide/vue';
import {
  agentComputerConfigPutSchema,
  agentMcpServerPutSchema,
  agentMcpToolPutSchema,
  agentSkillConfigPutSchema,
  agentSkillContentPutSchema,
  agentSkillGithubImportSchema,
  agentSkillModePutSchema,
  agentSkillsSettingsPutSchema,
  agentToolPolicyPutSchema,
  fileSystemToolSettingKeys,
  type AgentAdminState,
  type AgentComputerAdminConfig,
  type AgentMcpServerAdmin,
  type AgentMcpToolAdmin,
  type AgentPluginAdmin,
  type AgentSecretUpdate,
  type AgentSkillAdmin,
  type AgentSkillConfigPut,
  type AgentToolPolicyState,
} from '@contracts';
import { jsonBody, rawApi } from '@/api/client';
import AgentPluginDetail from '@/components/AgentPluginDetail.vue';
import EmptyState from '@/components/EmptyState.vue';
import ManagedSettingsGrid from '@/components/ManagedSettingsGrid.vue';
import PendingChangesBar from '@/components/PendingChangesBar.vue';
import { useRuntimeStore } from '@/stores/runtime';
import { useManagedFeatureSettings } from './managed-settings';
import {
  buildAgentToolOverride,
  canAddAgentToolOverride,
  createAgentPolicyScopeOptions,
  createAgentToolOverrideDraft,
  hasAgentToolOverride,
  type AgentPolicyScopeOption,
  type AgentToolOverrideInput,
} from './agent-tool-policy';

type SectionName = 'mcp' | 'tools' | 'skills' | 'plugins';
type SecretDraft = { value: string; clear: boolean; configured: boolean };
type SecretRowDraft = { name: string; value: string; configured: boolean };
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

const sections: Array<{ name: SectionName; label: string }> = [
  { name: 'mcp', label: 'MCP' },
  { name: 'tools', label: 'Tools' },
  { name: 'skills', label: 'Skills' },
  { name: 'plugins', label: 'Plugin' },
];

const route = useRoute();
const router = useRouter();
const runtime = useRuntimeStore();
const activeSection = ref<SectionName>('mcp');
const state = ref<AgentAdminState | null>(null);
const policy = ref<AgentToolPolicyState | null>(null);
const loading = ref(false);
const pending = ref('');
const loadError = ref('');
const mcpQuery = ref('');
const toolQuery = ref('');
const skillQuery = ref('');
const pluginQuery = ref('');

const toolOverrides = ref<AgentToolOverrideInput[]>([]);
const savedToolOverridesText = ref('[]');
const addToolOverrideOpen = ref(false);
const toolOverrideDraft = reactive(createAgentToolOverrideDraft());
const toolOverrideScope = ref<AgentPolicyScopeOption | null>(null);

const mcpDialogOpen = ref(false);
const mcpDraft = ref<McpServerDraft>(createMcpDraft());
const mcpToolDialogOpen = ref(false);
const mcpToolEditing = ref<AgentMcpToolAdmin | null>(null);
const mcpToolDraft = reactive({ enabled: true, timeout: 60, selector: [] as string[] });

const skillSettingsOpen = ref(false);
const skillDirs = ref<string[]>([]);
const skillToken = reactive<SecretDraft>({ value: '', clear: false, configured: false });
const skillImportOpen = ref(false);
const skillImportUrl = ref('');
const skillConfigOpen = ref(false);
const skillConfigEditing = ref<AgentSkillAdmin | null>(null);
const skillConfigDraft = ref<AgentSkillConfigPut | null>(null);
const skillContentOpen = ref(false);
const skillContentId = ref('');
const skillContentName = ref('');
const skillContent = ref('');

const pluginEditing = ref<AgentPluginAdmin | null>(null);
const computerDraft = ref<AgentComputerAdminConfig | null>(null);
const computerE2bKey = ref<SecretDraft>({ value: '', clear: false, configured: false });
const computerOpenTerminalKey = ref<SecretDraft>({ value: '', clear: false, configured: false });
const savedComputerDraftText = ref('');
const savedComputerSecretsText = ref('');

const {
  fields: fileSystemFields,
  draft: fileSystemDraft,
  clearSecrets: fileSystemClearSecrets,
  hasChanges: hasFileSystemChanges,
  load: loadFileSystemSettings,
  save: saveFileSystemSettings,
} = useManagedFeatureSettings(fileSystemToolSettingKeys);

const serializedToolOverrides = computed(() => JSON.stringify(toolOverrides.value));
const toolOverridesChanged = computed(() => (
  serializedToolOverrides.value !== savedToolOverridesText.value
));
const hasUnsavedChanges = computed(() => (
  toolOverridesChanged.value || hasFileSystemChanges.value
));
const computerSecretsText = computed(() => JSON.stringify({
  e2b: computerE2bKey.value,
  openTerminal: computerOpenTerminalKey.value,
}));
const computerDraftModel = computed({
  get: () => {
    if (!computerDraft.value) throw new Error('Computer Plugin detail requires a draft.');
    return computerDraft.value;
  },
  set: (value: AgentComputerAdminConfig) => {
    computerDraft.value = value;
  },
});
const computerDirty = computed(() => Boolean(
  pluginEditing.value
  && computerDraft.value
  && (
    JSON.stringify(computerDraft.value) !== savedComputerDraftText.value
    || computerSecretsText.value !== savedComputerSecretsText.value
  )
));
const toolScopeOptions = computed(() => createAgentPolicyScopeOptions(
  policy.value?.defaultScopes ?? [],
  policy.value?.scopes ?? [],
));
const toolOverrideDuplicate = computed(() => hasAgentToolOverride(
  toolOverrides.value,
  toolOverrideDraft,
  toolOverrideScope.value,
));
const toolOverrideReady = computed(() => (
  canAddAgentToolOverride(toolOverrideDraft, toolOverrideScope.value)
  && !toolOverrideDuplicate.value
));
const filteredSkills = computed(() => {
  const query = skillQuery.value.trim().toLowerCase();
  return (state.value?.skills.catalog ?? []).filter((skill) => (
    !query || `${skill.name} ${skill.description} ${skill.id}`.toLowerCase().includes(query)
  ));
});
const filteredMcpServers = computed(() => {
  const query = mcpQuery.value.trim().toLowerCase();
  return (state.value?.mcp.servers ?? []).filter((server) => (
    !query || `${server.name} ${server.type} ${server.url ?? ''} ${server.command ?? ''}`
      .toLowerCase().includes(query)
  ));
});
const filteredPlugins = computed(() => {
  const query = pluginQuery.value.trim().toLowerCase();
  return (state.value?.plugins.catalog ?? []).filter((plugin) => (
    !query || `${plugin.displayName} ${plugin.shortDescription} ${plugin.category}`
      .toLowerCase().includes(query)
  ));
});
const toolRows = computed(() => {
  const runtimeTools = new Map(
    (state.value?.tools.catalog ?? []).map((tool) => [tool.name, tool]),
  );
  const mcpTools = new Map(
    (state.value?.mcp.tools ?? []).map((tool) => [tool.name, tool]),
  );
  const rows = (policy.value?.catalog ?? []).map((entry) => ({
    name: entry.toolName,
    title: entry.title || entry.toolName,
    description: entry.description,
    source: entry.source,
    registered: entry.registered ?? runtimeTools.has(entry.toolName),
    enabled: runtimeTools.get(entry.toolName)?.enabled ?? false,
    routes: entry.availableRoutes,
    mcpTool: mcpTools.get(entry.toolName),
  }));
  for (const tool of runtimeTools.values()) {
    if (rows.some((row) => row.name === tool.name)) continue;
    rows.push({
      name: tool.name,
      title: tool.name,
      description: tool.description ?? '',
      source: 'chatluna_runtime' as const,
      registered: true,
      enabled: tool.enabled,
      routes: ['agent' as const],
      mcpTool: mcpTools.get(tool.name),
    });
  }
  const query = toolQuery.value.trim().toLowerCase();
  return rows
    .filter((tool) => !query || `${tool.title} ${tool.name} ${tool.description}`
      .toLowerCase().includes(query))
    .sort((a, b) => a.title.localeCompare(b.title));
});

function sectionCount(section: SectionName): number {
  if (!state.value) return 0;
  if (section === 'mcp') return state.value.mcp.servers.length;
  if (section === 'tools') return toolRows.value.length;
  if (section === 'skills') return state.value.skills.catalog.length;
  return state.value.plugins.catalog.length;
}

function pluginContentSummary(plugin: AgentPluginAdmin): string {
  return [
    plugin.contents.mcpServers.length ? `${plugin.contents.mcpServers.length} MCP` : '',
    plugin.contents.skills.length ? `${plugin.contents.skills.length} Skills` : '',
    plugin.contents.tools.length ? `${plugin.contents.tools.length} Tools` : '',
  ].filter(Boolean).join(' · ');
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

function secretUpdate(secret: SecretDraft): AgentSecretUpdate {
  if (secret.clear) return { operation: 'clear' };
  if (secret.value) return { operation: 'set', value: secret.value };
  return secret.configured ? { operation: 'keep' } : { operation: 'clear' };
}

function secretRows(rows: SecretRowDraft[]) {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => ({
      name: row.name.trim(),
      update: row.value
        ? { operation: 'set' as const, value: row.value }
        : row.configured
          ? { operation: 'keep' as const }
          : { operation: 'clear' as const },
    }));
}

function sectionFromQuery(value: unknown): SectionName {
  return sections.some((section) => section.name === value) ? value as SectionName : 'mcp';
}

async function selectSection(section: SectionName): Promise<void> {
  activeSection.value = section;
  if (route.query.section !== section) {
    await router.replace({ query: { ...route.query, section } });
  }
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const [agentState, toolPolicy] = await Promise.all([
      rawApi<AgentAdminState>('/agent'),
      rawApi<AgentToolPolicyState>('/agent/tools/policy'),
      loadFileSystemSettings(),
    ]);
    state.value = agentState;
    policy.value = toolPolicy;
    toolOverrides.value = toolPolicy.overrides.map((item) => ({
      toolName: item.toolName,
      routeProfile: item.routeProfile,
      scopeKind: item.scopeKind,
      scopeId: item.scopeId,
      enabled: Boolean(item.enabled),
    }));
    savedToolOverridesText.value = serializedToolOverrides.value;
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Agent 状态读取失败';
  } finally {
    loading.value = false;
  }
}

async function refreshAgent(): Promise<void> {
  const next = await rawApi<AgentAdminState>('/agent');
  state.value = next;
  if (pluginEditing.value) {
    pluginEditing.value = next.plugins.catalog.find(
      (plugin) => plugin.id === pluginEditing.value?.id,
    ) ?? null;
  }
}

async function runAction(
  key: string,
  success: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  if (pending.value) return;
  pending.value = key;
  try {
    await operation();
    ElMessage.success(success);
    await refreshAgent();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : `${success}失败`);
  } finally {
    pending.value = '';
  }
}

function openMcpServer(server?: AgentMcpServerAdmin): void {
  mcpDraft.value = createMcpDraft(server);
  mcpDialogOpen.value = true;
}

async function saveMcpServer(): Promise<void> {
  const draft = mcpDraft.value;
  await runAction('mcp-server', 'MCP Server 已保存', async () => {
    await rawApi('/agent/mcp/server', {
      method: 'PUT',
      body: jsonBody(agentMcpServerPutSchema, {
        oldName: draft.oldName,
        name: draft.name,
        config: {
          type: draft.type,
          ...(draft.type === 'stdio' ? { command: draft.command, args: draft.args } : { url: draft.url }),
          timeout: draft.timeout,
          ...(draft.cwd ? { cwd: draft.cwd } : {}),
          ...(draft.proxy ? { proxy: draft.proxy } : {}),
          env: secretRows(draft.env),
          headers: secretRows(draft.headers),
        },
      }),
    });
    mcpDialogOpen.value = false;
  });
}

async function removeMcpServer(server: AgentMcpServerAdmin): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除 MCP Server「${server.name}」？`, '删除 MCP Server', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  await runAction(`remove-mcp-${server.name}`, 'MCP Server 已删除', async () => {
    await rawApi(`/agent/mcp/servers/${encodeURIComponent(server.name)}`, { method: 'DELETE' });
  });
}

function openMcpTool(tool: AgentMcpToolAdmin): void {
  mcpToolEditing.value = tool;
  mcpToolDraft.enabled = tool.enabled;
  mcpToolDraft.timeout = tool.timeout ?? 60;
  mcpToolDraft.selector = [...tool.selector];
  mcpToolDialogOpen.value = true;
}

async function saveMcpTool(): Promise<void> {
  const tool = mcpToolEditing.value;
  if (!tool) return;
  await runAction(`mcp-tool-${tool.name}`, 'MCP Tool 已保存', async () => {
    await rawApi(`/agent/mcp/tools/${encodeURIComponent(tool.name)}`, {
      method: 'PUT',
      body: jsonBody(agentMcpToolPutSchema, {
        enabled: mcpToolDraft.enabled,
        timeout: mcpToolDraft.timeout,
        selector: mcpToolDraft.selector,
      }),
    });
    mcpToolDialogOpen.value = false;
  });
}

function openToolOverrideDialog(): void {
  Object.assign(toolOverrideDraft, createAgentToolOverrideDraft());
  toolOverrideScope.value = null;
  addToolOverrideOpen.value = true;
}

function addToolOverride(): void {
  toolOverrides.value.push(buildAgentToolOverride(toolOverrideDraft, toolOverrideScope.value));
  addToolOverrideOpen.value = false;
}

async function saveToolPolicy(): Promise<void> {
  if (!hasUnsavedChanges.value || runtime.restartInProgress) return;
  pending.value = 'tool-policy';
  try {
    if (toolOverridesChanged.value) {
      await rawApi('/agent/tools/policy', {
        method: 'PATCH',
        body: jsonBody(agentToolPolicyPutSchema, { overrides: toolOverrides.value }),
      });
    }
    if (hasFileSystemChanges.value) await saveFileSystemSettings();
    ElMessage.success('Tools 设置已保存');
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Tools 设置保存失败');
  } finally {
    pending.value = '';
  }
}

async function discardToolPolicy(): Promise<void> {
  if (!hasUnsavedChanges.value) return;
  try {
    await ElMessageBox.confirm('将丢弃尚未保存的工具权限与文件边界设置。', '放弃修改？', {
      type: 'warning',
      confirmButtonText: '放弃修改',
      cancelButtonText: '继续编辑',
    });
  } catch {
    return;
  }
  await load();
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
  await runAction('skill-settings', 'Skills 来源已保存', async () => {
    await rawApi('/agent/skills/settings', {
      method: 'PUT',
      body: jsonBody(agentSkillsSettingsPutSchema, {
        dirs: skillDirs.value,
        githubToken: secretUpdate(skillToken),
      }),
    });
    skillSettingsOpen.value = false;
  });
}

async function setSkillMode(skill: AgentSkillAdmin, mode: AgentSkillAdmin['mode']): Promise<void> {
  await runAction(`skill-mode-${skill.id}`, 'Skill 模式已更新', async () => {
    await rawApi(`/agent/skills/${encodeURIComponent(skill.id)}/mode`, {
      method: 'PUT',
      body: jsonBody(agentSkillModePutSchema, { mode }),
    });
  });
}

async function toggleSkillEnabled(
  skill: AgentSkillAdmin,
  value: string | number | boolean,
): Promise<void> {
  await setSkillMode(skill, value ? 'description' : 'off');
}

function openSkillConfig(skill: AgentSkillAdmin): void {
  skillConfigEditing.value = skill;
  skillConfigDraft.value = {
    enabled: skill.enabled,
    mode: skill.mode === 'off' ? 'description' : skill.mode,
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
  };
  skillConfigOpen.value = true;
}

async function saveSkillConfig(): Promise<void> {
  if (!skillConfigEditing.value || !skillConfigDraft.value) return;
  const id = skillConfigEditing.value.id;
  await runAction(`skill-config-${id}`, 'Skill 设置已保存', async () => {
    await rawApi(`/agent/skills/${encodeURIComponent(id)}/config`, {
      method: 'PUT',
      body: jsonBody(agentSkillConfigPutSchema, skillConfigDraft.value),
    });
    skillConfigOpen.value = false;
  });
}

async function openSkillContent(skill: AgentSkillAdmin): Promise<void> {
  pending.value = `skill-content-${skill.id}`;
  try {
    const result = await rawApi<{ id: string; content: string }>(
      `/agent/skills/${encodeURIComponent(skill.id)}/content`,
    );
    skillContentId.value = skill.id;
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
  await runAction(`skill-content-save-${skillContentId.value}`, 'Skill 内容已保存', async () => {
    await rawApi(`/agent/skills/${encodeURIComponent(skillContentId.value)}/content`, {
      method: 'PUT',
      body: jsonBody(agentSkillContentPutSchema, { content: skillContent.value }),
    });
    skillContentOpen.value = false;
  });
}

async function importSkill(): Promise<void> {
  await runAction('skill-import', 'Skill 已导入', async () => {
    await rawApi('/agent/skills/import/github', {
      method: 'POST',
      body: jsonBody(agentSkillGithubImportSchema, { url: skillImportUrl.value }),
    });
    skillImportOpen.value = false;
    skillImportUrl.value = '';
  });
}

async function removeSkill(skill: AgentSkillAdmin): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除 Skill「${skill.name}」？`, '删除 Skill', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  await runAction(`skill-remove-${skill.id}`, 'Skill 已删除', async () => {
    await rawApi(`/agent/skills/${encodeURIComponent(skill.id)}`, { method: 'DELETE' });
  });
}

function openPlugin(plugin: AgentPluginAdmin): void {
  pluginEditing.value = plugin;
  computerDraft.value = structuredClone(toRaw(plugin.computer.config));
  computerE2bKey.value = {
    value: '',
    clear: false,
    configured: plugin.computer.config.e2b.apiKeyConfigured,
  };
  computerOpenTerminalKey.value = {
    value: '',
    clear: false,
    configured: plugin.computer.config.openTerminal.apiKeyConfigured,
  };
  savedComputerDraftText.value = JSON.stringify(computerDraft.value);
  savedComputerSecretsText.value = computerSecretsText.value;
}

function computerConfigBody(
  draft: AgentComputerAdminConfig,
  e2bApiKey: AgentSecretUpdate,
  openTerminalApiKey: AgentSecretUpdate,
) {
  const { apiKeyConfigured: _e2bConfigured, ...e2b } = draft.e2b;
  const { apiKeyConfigured: _terminalConfigured, ...openTerminal } = draft.openTerminal;
  return jsonBody(agentComputerConfigPutSchema, {
    config: {
      defaultProvider: draft.defaultProvider,
      idleTimeoutMs: draft.idleTimeoutMs,
      local: draft.local,
      e2b,
      openTerminal,
    },
    e2bApiKey,
    openTerminalApiKey,
  });
}

async function saveComputerPlugin(): Promise<void> {
  if (!computerDraft.value || pending.value) return;
  pending.value = 'computer-plugin';
  try {
    await rawApi('/agent/plugins/computer', {
      method: 'PUT',
      body: computerConfigBody(
        computerDraft.value,
        secretUpdate(computerE2bKey.value),
        secretUpdate(computerOpenTerminalKey.value),
      ),
    });
    ElMessage.success('Computer Plugin 已保存');
    await refreshAgent();
    const updated = state.value?.plugins.catalog.find((plugin) => plugin.id === 'computer');
    if (updated) openPlugin(updated);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Computer Plugin 保存失败');
  } finally {
    pending.value = '';
  }
}

function setComputerDraftEnabled(draft: AgentComputerAdminConfig, enabled: boolean): void {
  if (!enabled) {
    draft.local.enabled = false;
    draft.e2b.enabled = false;
    draft.openTerminal.enabled = false;
    return;
  }
  if (draft.defaultProvider === 'local') draft.local.enabled = true;
  if (draft.defaultProvider === 'e2b') draft.e2b.enabled = true;
  if (draft.defaultProvider === 'open-terminal') draft.openTerminal.enabled = true;
}

async function setComputerPluginEnabled(plugin: AgentPluginAdmin, enabled: boolean): Promise<void> {
  const draft = structuredClone(toRaw(plugin.computer.config));
  setComputerDraftEnabled(draft, enabled);
  await runAction(
    'computer-plugin-toggle',
    enabled ? 'Computer Plugin 已启动' : 'Computer Plugin 已停止',
    () => rawApi('/agent/plugins/computer', {
      method: 'PUT',
      body: computerConfigBody(
        draft,
        plugin.computer.config.e2b.apiKeyConfigured
          ? { operation: 'keep' }
          : { operation: 'clear' },
        plugin.computer.config.openTerminal.apiKeyConfigured
          ? { operation: 'keep' }
          : { operation: 'clear' },
      ),
    }),
  );
}

async function closePlugin(): Promise<void> {
  if (computerDirty.value) {
    try {
      await ElMessageBox.confirm('Computer 仍有未保存修改。', '返回 Plugin？', {
        type: 'warning',
        confirmButtonText: '放弃并返回',
        cancelButtonText: '继续编辑',
      });
    } catch {
      return;
    }
  }
  pluginEditing.value = null;
  computerDraft.value = null;
  savedComputerDraftText.value = '';
  savedComputerSecretsText.value = '';
}

async function navigateFromPlugin(section: 'mcp' | 'tools' | 'skills'): Promise<void> {
  await closePlugin();
  if (pluginEditing.value) return;
  await selectSection(section);
}

async function probeComputerBackend(type: 'local' | 'e2b' | 'open-terminal'): Promise<void> {
  await runAction(`probe-${type}`, `${type} backend 探测完成`, async () => {
    await rawApi(`/agent/plugins/computer/backends/${type}/probe`, { method: 'POST' });
  });
}

function scopeLabel(override: AgentToolOverrideInput): string {
  return toolScopeOptions.value.find((scope) => (
    scope.scopeKind === override.scopeKind && scope.scopeId === override.scopeId
  ))?.label ?? override.scopeId;
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedChanges.value && !computerDirty.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onBeforeRouteLeave(async () => {
  if (!hasUnsavedChanges.value && !computerDirty.value) return true;
  try {
    await ElMessageBox.confirm('Agent 仍有未保存修改。', '离开 Agent？', {
      type: 'warning',
      confirmButtonText: '放弃并离开',
      cancelButtonText: '继续编辑',
    });
    return true;
  } catch {
    return false;
  }
});

function handleSave(): void {
  if (pluginEditing.value && computerDirty.value) {
    void saveComputerPlugin();
    return;
  }
  if (activeSection.value === 'tools') void saveToolPolicy();
}

watch(() => route.query.section, (section) => {
  activeSection.value = sectionFromQuery(section);
}, { immediate: true });
onMounted(() => {
  void load();
  window.addEventListener('admin-save', handleSave);
  window.addEventListener('beforeunload', beforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener('admin-save', handleSave);
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <AgentPluginDetail
    v-if="pluginEditing && computerDraft"
    v-model:draft="computerDraftModel"
    v-model:e2b-key="computerE2bKey"
    v-model:open-terminal-key="computerOpenTerminalKey"
    :plugin="pluginEditing"
    :pending="pending"
    :dirty="computerDirty"
    @back="closePlugin"
    @save="saveComputerPlugin"
    @probe="probeComputerBackend"
    @navigate="navigateFromPlugin"
  />

  <article v-else class="agent-page">
    <header class="agent-header">
      <div>
        <h1>Agent</h1>
        <p>MCP、Tools、Skills 与 Plugin 的运行入口。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>

    <nav class="agent-tabs" aria-label="Agent 模块">
      <button
        v-for="section in sections"
        :key="section.name"
        type="button"
        :class="{ active: activeSection === section.name }"
        @click="selectSection(section.name)"
      >
        <span>{{ section.label }}</span>
        <small>{{ sectionCount(section.name) }}</small>
      </button>
    </nav>

    <div v-if="loadError" class="load-error">
      <span>{{ loadError }}</span>
      <el-button text @click="load">重试</el-button>
    </div>

    <transition name="section-fade" mode="out-in">
      <section v-if="state && policy" :key="activeSection" class="agent-surface">
        <template v-if="activeSection === 'mcp'">
          <div class="section-head">
            <div>
              <h2>MCP</h2>
              <p>连接 Agent 使用的协议服务。</p>
            </div>
            <div class="section-actions">
              <el-input v-model="mcpQuery" clearable placeholder="搜索 MCP" class="section-search" />
              <el-button :loading="pending === 'mcp-reload'" @click="runAction('mcp-reload', 'MCP 已重载', () => rawApi('/agent/mcp/reload', { method: 'POST' }))">
                <RotateCw :size="15" />重载
              </el-button>
              <el-button type="primary" @click="openMcpServer()">新增 Server</el-button>
            </div>
          </div>

          <div v-if="filteredMcpServers.length" class="quiet-list">
            <article v-for="server in filteredMcpServers" :key="server.name" class="quiet-row">
              <button type="button" class="row-select" @click="openMcpServer(server)">
                <span class="row-icon"><Server :size="17" /></span>
                <span class="row-main">
                  <span class="row-title"><strong>{{ server.name }}</strong><small>{{ server.type }}</small></span>
                  <span class="row-description">{{ server.url || [server.command, ...(server.args || [])].filter(Boolean).join(' ') }}</span>
                  <small v-if="server.status?.error" class="row-error">{{ server.status.error }}</small>
                </span>
              </button>
              <div class="row-state">
                <span class="status-line"><i :class="server.status?.connected ? 'ok' : server.status?.state === 'error' ? 'bad' : ''" />{{ server.status?.stateText || '未连接' }}</span>
                <small>{{ server.status?.toolCount || 0 }} tools</small>
              </div>
              <div class="row-actions">
                <el-button text :loading="pending === `reconnect-${server.name}`" @click="runAction(`reconnect-${server.name}`, 'MCP Server 已重连', () => rawApi(`/agent/mcp/servers/${encodeURIComponent(server.name)}/reconnect`, { method: 'POST' }))">重连</el-button>
                <el-button text type="danger" @click="removeMcpServer(server)">删除</el-button>
              </div>
              <ChevronRight class="row-chevron" :size="16" />
            </article>
          </div>
          <EmptyState v-else :title="mcpQuery ? '没有匹配的 MCP Server' : '尚未配置 MCP Server'" />
        </template>

        <template v-else-if="activeSection === 'tools'">
          <div class="section-head">
            <div>
              <h2>Tools</h2>
              <p>ChatLuna runtime registry 与调用边界。</p>
            </div>
            <el-input v-model="toolQuery" clearable placeholder="搜索 Tools" class="section-search" />
          </div>

          <div v-if="toolRows.length" class="quiet-list">
            <article v-for="tool in toolRows" :key="tool.name" class="quiet-row">
              <div class="row-select">
                <span class="row-icon"><Wrench :size="17" /></span>
                <span class="row-main">
                  <span class="row-title"><strong>{{ tool.title }}</strong><small class="mono">{{ tool.name }}</small></span>
                  <span class="row-description">{{ tool.description }}</span>
                </span>
              </div>
              <div class="row-state">
                <span class="status-line"><i :class="tool.registered && tool.enabled ? 'ok' : ''" />{{ tool.registered ? (tool.enabled ? '运行中' : '已停用') : '未注册' }}</span>
                <small>{{ tool.routes.join(' · ') }}</small>
              </div>
              <div v-if="tool.mcpTool" class="row-actions">
                <el-button text @click="openMcpTool(tool.mcpTool)">配置</el-button>
              </div>
            </article>
          </div>
          <EmptyState v-else title="没有匹配的 Tool" />

          <details class="settings-fold">
            <summary>
              <span>范围权限</span>
              <small>{{ toolOverrides.length }} 个自定义覆盖</small>
            </summary>
            <div class="fold-body">
              <div class="fold-head">
                <p>只记录偏离默认权限的范围。</p>
                <el-button @click="openToolOverrideDialog">添加覆盖</el-button>
              </div>
              <div v-if="toolOverrides.length" class="quiet-list compact">
                <div v-for="(override, index) in toolOverrides" :key="`${override.toolName}-${override.routeProfile}-${override.scopeKind}-${override.scopeId}`" class="quiet-row">
                  <div class="row-main">
                    <div class="row-title"><strong>{{ override.toolName }}</strong><small>{{ override.routeProfile }}</small></div>
                    <span class="row-description">{{ scopeLabel(override) }}</span>
                  </div>
                  <el-switch v-model="override.enabled" inline-prompt active-text="开" inactive-text="关" />
                  <div class="row-actions"><el-button text type="danger" @click="toolOverrides.splice(index, 1)">移除</el-button></div>
                </div>
              </div>
              <p v-else class="fold-empty">当前使用默认工具权限。</p>
            </div>
          </details>

          <details class="settings-fold">
            <summary>
              <span>文件与 Shell 边界</span>
              <small>访问范围与工作目录</small>
            </summary>
            <div class="fold-body">
              <ManagedSettingsGrid
                v-model="fileSystemDraft"
                v-model:clear-secrets="fileSystemClearSecrets"
                :fields="fileSystemFields"
              />
            </div>
          </details>
        </template>

        <template v-else-if="activeSection === 'skills'">
          <div class="section-head">
            <div>
              <h2>Skills</h2>
              <p>注入 Agent 的任务说明与操作流程。</p>
            </div>
            <div class="section-actions">
              <el-input v-model="skillQuery" clearable placeholder="搜索 Skills" class="section-search" />
              <el-button @click="openSkillSettings">来源</el-button>
              <el-button :loading="pending === 'skills-reload'" @click="runAction('skills-reload', 'Skills 已重载', () => rawApi('/agent/skills/reload', { method: 'POST' }))">
                <RotateCw :size="15" />重载
              </el-button>
              <el-button type="primary" @click="skillImportOpen = true">从 GitHub 导入</el-button>
            </div>
          </div>

          <div v-if="filteredSkills.length" class="quiet-list">
            <article v-for="skill in filteredSkills" :key="skill.id" class="quiet-row">
              <button type="button" class="row-select" @click="openSkillConfig(skill)">
                <span class="row-icon"><Sparkles :size="17" /></span>
                <span class="row-main">
                  <span class="row-title"><strong>{{ skill.name }}</strong><small>{{ skill.scope }}</small></span>
                  <span class="row-description">{{ skill.description }}</span>
                  <small v-if="skill.diagnostics.length" class="row-error">{{ skill.diagnostics[0] }}</small>
                </span>
              </button>
              <div class="row-state">
                <span class="status-line"><i :class="skill.available && skill.mode !== 'off' ? 'ok' : skill.state === 'invalid' ? 'bad' : ''" />{{ skill.mode === 'off' ? '已停止' : skill.available ? '运行中' : '不可用' }}</span>
                <small>{{ skill.mode === 'full' ? '全文注入' : skill.mode === 'description' ? '描述注入' : '' }}</small>
              </div>
              <el-switch
                :model-value="skill.mode !== 'off'"
                :loading="pending === `skill-mode-${skill.id}`"
                :aria-label="`${skill.mode === 'off' ? '启动' : '停止'} ${skill.name}`"
                @change="toggleSkillEnabled(skill, $event)"
              />
              <div class="row-actions">
                <el-button text @click="openSkillContent(skill)">内容</el-button>
                <el-button v-if="skill.scope === 'data'" text type="danger" @click="removeSkill(skill)">删除</el-button>
              </div>
              <ChevronRight class="row-chevron" :size="16" />
            </article>
          </div>
          <EmptyState v-else title="没有匹配的 Skill" />
        </template>

        <template v-else>
          <div class="section-head">
            <div>
              <h2>Plugin</h2>
              <p>将 MCP 与 Skills 作为一个能力包接入 Agent。</p>
            </div>
            <el-input v-model="pluginQuery" clearable placeholder="搜索 Plugin" class="section-search" />
          </div>

          <div v-if="filteredPlugins.length" class="quiet-list">
            <article v-for="plugin in filteredPlugins" :key="plugin.id" class="quiet-row plugin-row">
              <button type="button" class="row-select" @click="openPlugin(plugin)">
                <span class="row-icon"><Monitor :size="17" /></span>
                <span class="row-main">
                  <span class="row-title"><strong>{{ plugin.displayName }}</strong><small>{{ plugin.category }}</small></span>
                  <span class="row-description">{{ plugin.shortDescription }}</span>
                  <small class="row-meta">{{ pluginContentSummary(plugin) }}</small>
                </span>
              </button>
              <div class="row-state">
                <span class="status-line"><i :class="plugin.state === 'active' ? 'ok' : plugin.state === 'error' ? 'bad' : ''" />{{ plugin.state === 'active' ? '运行中' : plugin.state === 'error' ? '异常' : '已停止' }}</span>
              </div>
              <el-switch
                :model-value="plugin.state !== 'inactive'"
                :loading="pending === 'computer-plugin-toggle'"
                :aria-label="`${plugin.state === 'inactive' ? '启动' : '停止'} ${plugin.displayName}`"
                @change="setComputerPluginEnabled(plugin, Boolean($event))"
              />
              <ChevronRight class="row-chevron" :size="16" />
            </article>
          </div>
          <EmptyState v-else :title="pluginQuery ? '没有匹配的 Plugin' : '尚未安装 Plugin'" />
        </template>
      </section>
    </transition>
  </article>

  <PendingChangesBar
    v-if="hasUnsavedChanges"
    :saving="pending === 'tool-policy'"
    :disabled="runtime.restartInProgress"
    save-label="保存 Tools"
    @discard="discardToolPolicy"
    @save="saveToolPolicy"
  />

  <el-dialog v-model="mcpDialogOpen" :title="mcpDraft.oldName ? '编辑 MCP Server' : '新增 MCP Server'" width="min(680px, calc(100vw - 32px))">
    <el-form label-position="top" class="dialog-form">
      <div class="form-grid two">
        <el-form-item label="名称"><el-input v-model="mcpDraft.name" /></el-form-item>
        <el-form-item label="Transport"><el-select v-model="mcpDraft.type"><el-option label="stdio" value="stdio" /><el-option label="HTTP" value="http" /><el-option label="Streamable HTTP" value="streamable_http" /><el-option label="SSE" value="sse" /></el-select></el-form-item>
      </div>
      <template v-if="mcpDraft.type === 'stdio'">
        <el-form-item label="Command"><el-input v-model="mcpDraft.command" /></el-form-item>
        <el-form-item label="Args"><el-select v-model="mcpDraft.args" multiple filterable allow-create default-first-option /></el-form-item>
      </template>
      <el-form-item v-else label="URL"><el-input v-model="mcpDraft.url" /></el-form-item>
      <div class="form-grid two"><el-form-item label="Timeout（秒）"><el-input-number v-model="mcpDraft.timeout" :min="1" :max="600" /></el-form-item><el-form-item label="Working directory"><el-input v-model="mcpDraft.cwd" /></el-form-item></div>
      <el-form-item label="Proxy"><el-input v-model="mcpDraft.proxy" /></el-form-item>
      <div class="secret-section">
        <div class="inline-head"><strong>Environment</strong><el-button text @click="mcpDraft.env.push({ name: '', value: '', configured: false })">添加</el-button></div>
        <div v-for="(row, index) in mcpDraft.env" :key="index" class="secret-row"><el-input v-model="row.name" placeholder="NAME" /><el-input v-model="row.value" show-password :placeholder="row.configured ? '留空保留' : 'Value'" /><el-button text type="danger" @click="mcpDraft.env.splice(index, 1)">移除</el-button></div>
      </div>
      <div v-if="mcpDraft.type !== 'stdio'" class="secret-section">
        <div class="inline-head"><strong>Headers</strong><el-button text @click="mcpDraft.headers.push({ name: '', value: '', configured: false })">添加</el-button></div>
        <div v-for="(row, index) in mcpDraft.headers" :key="index" class="secret-row"><el-input v-model="row.name" placeholder="Header" /><el-input v-model="row.value" show-password :placeholder="row.configured ? '留空保留' : 'Value'" /><el-button text type="danger" @click="mcpDraft.headers.splice(index, 1)">移除</el-button></div>
      </div>
    </el-form>
    <template #footer><el-button @click="mcpDialogOpen = false">取消</el-button><el-button type="primary" :loading="pending === 'mcp-server'" @click="saveMcpServer">保存</el-button></template>
  </el-dialog>

  <el-dialog v-model="mcpToolDialogOpen" title="MCP Tool" width="min(520px, calc(100vw - 32px))">
    <el-form label-position="top"><el-form-item label="启用"><el-switch v-model="mcpToolDraft.enabled" /></el-form-item><el-form-item label="Timeout（秒）"><el-input-number v-model="mcpToolDraft.timeout" :min="1" :max="600" /></el-form-item><el-form-item label="Selector"><el-select v-model="mcpToolDraft.selector" multiple filterable allow-create default-first-option /></el-form-item></el-form>
    <template #footer><el-button @click="mcpToolDialogOpen = false">取消</el-button><el-button type="primary" @click="saveMcpTool">保存</el-button></template>
  </el-dialog>

  <el-dialog v-model="addToolOverrideOpen" title="添加工具权限覆盖" width="min(520px, calc(100vw - 32px))">
    <el-form label-position="top"><el-form-item label="Tool"><el-select v-model="toolOverrideDraft.toolName" filterable><el-option v-for="tool in policy?.catalog" :key="tool.toolName" :label="tool.title || tool.toolName" :value="tool.toolName" /></el-select></el-form-item><el-form-item label="Route"><el-select v-model="toolOverrideDraft.routeProfile"><el-option v-for="profile in policy?.routeProfiles" :key="profile" :label="profile" :value="profile" /></el-select></el-form-item><el-form-item label="范围" :error="toolOverrideDuplicate ? '这个范围已有相同覆盖' : ''"><el-select v-model="toolOverrideScope" value-key="key" filterable><el-option v-for="scope in toolScopeOptions" :key="scope.key" :label="scope.label" :value="scope" /></el-select></el-form-item><el-form-item label="允许"><el-switch v-model="toolOverrideDraft.enabled" /></el-form-item></el-form>
    <template #footer><el-button @click="addToolOverrideOpen = false">取消</el-button><el-button type="primary" :disabled="!toolOverrideReady" @click="addToolOverride">添加</el-button></template>
  </el-dialog>

  <el-dialog v-model="skillSettingsOpen" title="Skills 来源" width="min(600px, calc(100vw - 32px))">
    <el-form label-position="top"><el-form-item label="Directories"><el-select v-model="skillDirs" multiple filterable allow-create default-first-option /></el-form-item><el-form-item label="GitHub Token"><el-input v-model="skillToken.value" show-password :disabled="skillToken.clear" :placeholder="skillToken.configured ? '留空保留' : '可选'" /></el-form-item><el-checkbox v-if="skillToken.configured" v-model="skillToken.clear">清除已保存 Token</el-checkbox></el-form>
    <template #footer><el-button @click="skillSettingsOpen = false">取消</el-button><el-button type="primary" @click="saveSkillSettings">保存</el-button></template>
  </el-dialog>

  <el-dialog v-model="skillImportOpen" title="从 GitHub 导入 Skill" width="min(560px, calc(100vw - 32px))">
    <el-form label-position="top"><el-form-item label="Repository 或 Skill URL"><el-input v-model="skillImportUrl" placeholder="https://github.com/…" /></el-form-item></el-form>
    <template #footer><el-button @click="skillImportOpen = false">取消</el-button><el-button type="primary" :disabled="!skillImportUrl" @click="importSkill">导入</el-button></template>
  </el-dialog>

  <el-dialog v-model="skillConfigOpen" :title="`Skill 设置 · ${skillConfigEditing?.name || ''}`" width="min(640px, calc(100vw - 32px))">
    <el-form v-if="skillConfigDraft" label-position="top">
      <div class="switch-line"><span>启用</span><el-switch v-model="skillConfigDraft.enabled" /></div>
      <div class="form-grid two"><el-form-item label="注入模式"><el-select v-model="skillConfigDraft.mode"><el-option label="描述" value="description" /><el-option label="全文" value="full" /></el-select></el-form-item><el-form-item label="最低权限"><el-input-number v-model="skillConfigDraft.authority" :min="0" :max="5" /></el-form-item></div>
      <div class="check-grid"><el-checkbox v-model="skillConfigDraft.main">主 Agent</el-checkbox><el-checkbox v-model="skillConfigDraft.chatluna">ChatLuna</el-checkbox><el-checkbox v-model="skillConfigDraft.character">角色</el-checkbox><el-checkbox v-model="skillConfigDraft.characterGroup">群聊角色</el-checkbox><el-checkbox v-model="skillConfigDraft.characterPrivate">私聊角色</el-checkbox></div>
      <div class="form-grid two"><el-form-item label="允许群"><el-select v-model="skillConfigDraft.characterGroupIds" multiple filterable allow-create default-first-option /></el-form-item><el-form-item label="允许私聊"><el-select v-model="skillConfigDraft.characterPrivateIds" multiple filterable allow-create default-first-option /></el-form-item></div>
    </el-form>
    <template #footer><el-button @click="skillConfigOpen = false">取消</el-button><el-button type="primary" @click="saveSkillConfig">保存</el-button></template>
  </el-dialog>

  <el-dialog v-model="skillContentOpen" :title="skillContentName" width="min(820px, calc(100vw - 32px))">
    <el-input v-model="skillContent" type="textarea" :rows="22" class="content-editor" />
    <template #footer><el-button @click="skillContentOpen = false">取消</el-button><el-button type="primary" @click="saveSkillContent">保存</el-button></template>
  </el-dialog>

</template>

<style scoped>
.agent-page{max-width:1180px;margin:0 auto;color:var(--ink)}
.agent-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:8px 4px 24px}.agent-header h1{margin:0;font-size:26px;line-height:1.2;letter-spacing:-.03em}.agent-header p,.section-head p{margin:6px 0 0;color:var(--muted);font-size:13px}
.agent-tabs{display:flex;gap:28px;border-bottom:1px solid var(--line)}.agent-tabs button{position:relative;display:flex;align-items:baseline;gap:6px;margin:0;padding:0 0 12px;border:0;background:transparent;color:var(--muted);font:inherit;font-size:13px;cursor:pointer}.agent-tabs button small{font-size:10px}.agent-tabs button::after{position:absolute;right:0;bottom:-1px;left:0;height:2px;background:var(--accent);content:"";opacity:0;transform:scaleX(.45);transition:opacity .16s ease,transform .16s ease}.agent-tabs button.active{color:var(--ink);font-weight:650}.agent-tabs button.active::after{opacity:1;transform:scaleX(1)}
.agent-surface{min-height:420px;padding:28px 0 40px}.section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:18px}.section-head h2{margin:0;font-size:17px;letter-spacing:-.02em}.section-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.section-actions :deep(.el-button){display:inline-flex;align-items:center;gap:6px;margin-left:0}.section-search{width:220px}
.quiet-list{border-top:1px solid var(--line)}.quiet-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;align-items:center;gap:12px;min-height:70px;padding:9px 6px;border-bottom:1px solid var(--line);transition:background-color .14s ease}.quiet-row:hover{background:color-mix(in srgb,var(--surface) 88%,var(--accent) 12%)}.quiet-list.compact .quiet-row{min-height:56px}.row-select{display:flex;align-items:center;gap:12px;min-width:0;padding:3px 0;border:0;background:transparent;color:inherit;text-align:left}.row-select:is(button){cursor:pointer}.row-icon{display:grid;width:38px;height:38px;flex:0 0 38px;place-items:center;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink)}
.row-main{display:flex;min-width:0;flex-direction:column;gap:4px}.row-title{display:flex;align-items:baseline;gap:9px;min-width:0}.row-title strong{overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.row-title small,.row-meta{color:var(--muted);font-size:10px}.row-description{overflow:hidden;color:var(--muted);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.row-error{overflow:hidden;color:#a85252;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.row-state{display:flex;min-width:82px;flex-direction:column;align-items:flex-end;color:var(--muted);font-size:11px}.row-state small{margin-top:3px}.status-line{display:flex;align-items:center;gap:6px;white-space:nowrap}.status-line i{width:7px;height:7px;border-radius:50%;background:#b5bcc5}.status-line i.ok{background:#3a8b68}.status-line i.bad{background:#c45d5d}.row-actions{display:flex;align-items:center;flex:0 0 auto}.row-actions :deep(.el-button){margin-left:0}.row-chevron{color:var(--muted)}.mono{font-family:var(--font-mono,ui-monospace,monospace)}
.settings-fold{margin-top:24px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.settings-fold+.settings-fold{margin-top:-1px}.settings-fold summary{display:flex;align-items:center;justify-content:space-between;padding:16px 4px;cursor:pointer;list-style:none;font-size:13px;font-weight:650}.settings-fold summary::-webkit-details-marker{display:none}.settings-fold summary small{color:var(--muted);font-size:11px;font-weight:400}.fold-body{padding:2px 4px 20px}.fold-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}.fold-head p,.fold-empty{margin:0;color:var(--muted);font-size:12px}.settings-fold :deep(.settings-grid){padding-bottom:4px}
.load-error{display:flex;align-items:center;justify-content:space-between;margin-top:18px;padding:10px 12px;border-left:2px solid #c45d5d;background:#fff7f7;color:#8f4444;font-size:12px}
.form-grid{display:grid;gap:14px}.form-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.dialog-form :deep(.el-select),.dialog-form :deep(.el-input-number){width:100%}.secret-section{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}.inline-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.secret-row{display:grid;grid-template-columns:1fr 1.5fr auto;gap:8px;margin-top:8px}.switch-line{display:flex;align-items:center;justify-content:space-between;min-height:42px;border-bottom:1px solid var(--line);font-size:13px}.check-grid{display:flex;gap:16px;margin:12px 0 18px;flex-wrap:wrap}.content-editor :deep(textarea){font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;line-height:1.6}
.section-fade-enter-active,.section-fade-leave-active{transition:opacity .14s ease,transform .14s ease}.section-fade-enter-from{opacity:0;transform:translateY(4px)}.section-fade-leave-to{opacity:0;transform:translateY(-2px)}
@media(max-width:800px){.section-head{align-items:stretch;flex-direction:column}.section-actions{justify-content:flex-start}.section-search{width:100%}.quiet-row{grid-template-columns:minmax(0,1fr) auto}.row-select{grid-column:1/-1}.row-state{min-width:0;align-items:flex-start}.row-actions{justify-self:end}.row-chevron{display:none}.form-grid.two{grid-template-columns:1fr}}
@media(max-width:520px){.agent-tabs{gap:20px}.agent-header p{max-width:250px}.section-actions{align-items:stretch;flex-direction:column}.section-actions>.el-button{margin-left:0}.quiet-row{grid-template-columns:1fr auto}.row-description{white-space:normal}.secret-row{grid-template-columns:1fr}.fold-head{align-items:flex-start;flex-direction:column}}
</style>
