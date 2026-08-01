<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  agentMcpToolPutSchema,
  agentToolPutSchema,
  type AgentAdminState,
  type AgentMcpToolAdmin,
  type AgentToolPolicyState,
} from '@contracts';
import { ApiError, jsonBody, rawApi } from '@/api/client';
import ContextPayloadPreview from '@/components/ContextPayloadPreview.vue';
import ContextRuntimeInspector from '@/components/ContextRuntimeInspector.vue';
import PendingChangesBar from '@/components/PendingChangesBar.vue';
import {
  createContextPreset,
  createRolePreset,
  deleteContextPreset,
  deleteContextPresetOverride,
  deleteRolePreset,
  deleteRolePresetOverride,
  getContextPreset,
  getPromptFragmentPolicy,
  getRolePreset,
  listContextPresets,
  listRolePresets,
  previewContextPreset,
  resetPromptFragmentPolicy,
  setDefaultContextPreset,
  updateContextPreset,
  updatePromptFragmentPolicy,
  updateRolePreset,
  type AuthorsNoteContextBlock,
  type BudgetedContextBlock,
  type ContextPresetBlock,
  type ContextPresetCatalogResponse,
  type ContextPresetDefinitionV1,
  type ContextPresetDetailResponse,
  type ContextPresetPreviewResponse,
  type KnowledgeContextBlock,
  type LoreContextBlock,
  type ModelOutputContextBlock,
  type PromptFragmentPolicyConfig,
  type PromptFragmentPolicyState,
  type RepeatableContextBlockType,
  type ResolvedContextBlock,
  type RoleContextBlock,
  type RolePresetCatalogResponse,
  type RolePresetDefinitionV1,
  type RolePresetDetailResponse,
  type RolePresetMessage,
  type StoredContextBlockType,
} from '@/api/context-presets';
import {
  agentScratchpadExample,
  chatHistoryExample,
  contextBlockGuides,
  currentInputExample,
  defaultKnowledgePrompt,
  modelOutputExample,
  requestDocumentExample,
  runtimeInstructionExample,
  toolDefinitionsExample,
  configurableQqbotFragmentChannels,
  type ContextPayloadExample,
  type GuidedContextBlockType,
} from './context-preset-guides';

type EditableStoredContextBlockType = Exclude<StoredContextBlockType, 'longMemory'>;
type TokenLimitChoice = 'auto' | '1024' | '2048' | '4096' | '8192' | 'custom';

const router = useRouter();
const contextCatalog = ref<ContextPresetCatalogResponse | null>(null);
const roleCatalog = ref<RolePresetCatalogResponse | null>(null);
const selectedContextId = ref('');
const contextDetail = ref<ContextPresetDetailResponse | null>(null);
const contextDraft = ref<ContextPresetDefinitionV1 | null>(null);
const savedContextText = ref('');
const roleDetail = ref<RolePresetDetailResponse | null>(null);
const roleDraft = ref<RolePresetDefinitionV1 | null>(null);
const savedRoleText = ref('');
const fragmentPolicyState = ref<PromptFragmentPolicyState | null>(null);
const fragmentPolicyDraft = ref<PromptFragmentPolicyConfig | null>(null);
const savedFragmentPolicyText = ref('');
const selectedBlockId = ref('');
const preview = ref<ContextPresetPreviewResponse | null>(null);
const previewError = ref<{ message: string; details: Record<string, unknown> | null } | null>(null);
const loading = ref(false);
const savingContext = ref(false);
const savingRole = ref(false);
const savingFragmentPolicy = ref(false);
const mutating = ref(false);
const draggingBlockId = ref<string | null>(null);
const customTokenLimitBlockId = ref('');
const agentState = ref<AgentAdminState | null>(null);
const agentToolPolicy = ref<AgentToolPolicyState | null>(null);
const agentToolsLoading = ref(false);
const pendingAgentTool = ref('');
const agentToolQuery = ref('');
let previewTimer: number | undefined;
let previewSequence = 0;

const tokenLimitOptions: Array<{ label: string; value: TokenLimitChoice }> = [
  { label: '自动', value: 'auto' },
  { label: '1K', value: '1024' },
  { label: '2K', value: '2048' },
  { label: '4K', value: '4096' },
  { label: '8K', value: '8192' },
  { label: '自定义', value: 'custom' },
];

const blockLabels: Record<ResolvedContextBlock['type'], string> = {
  role: '角色提示',
  chatHistory: '聊天历史',
  requestDocuments: '请求文档',
  lore: 'Lore',
  authorsNote: '作者注',
  knowledge: '知识来源',
  currentInput: '当前输入',
  agentScratchpad: 'Agent Scratchpad',
  modelOutput: '模型输出',
  qqbotFragments: 'Runtime 指令',
  toolDefinitions: '工具定义',
};

const contextDirty = computed(() => (
  contextDraft.value !== null
  && JSON.stringify(contextDraft.value) !== savedContextText.value
));
const roleDirty = computed(() => (
  roleDraft.value !== null
  && JSON.stringify(roleDraft.value) !== savedRoleText.value
));
const fragmentPolicyDirty = computed(() => (
  fragmentPolicyDraft.value !== null
  && JSON.stringify(fragmentPolicyDraft.value) !== savedFragmentPolicyText.value
));
const hasDirtyResources = computed(() => (
  contextDirty.value || roleDirty.value || fragmentPolicyDirty.value
));
const contextSummaries = computed(() => contextCatalog.value?.contextPresets ?? []);
const roleSummaries = computed(() => roleCatalog.value?.rolePresets ?? []);
const selectedResolvedBlock = computed(() => (
  preview.value?.blocks.find((block) => block.id === selectedBlockId.value) ?? null
));
const selectedStoredBlock = computed<ContextPresetBlock | null>(() => (
  contextDraft.value?.blocks.find((block) => block.id === selectedBlockId.value) ?? null
));
const selectedBlockType = computed<ResolvedContextBlock['type'] | null>(() => {
  const type = selectedResolvedBlock.value?.type ?? selectedStoredBlock.value?.type ?? null;
  return type === 'longMemory' ? null : type;
});
const selectedBudgetBlock = computed<BudgetedContextBlock | null>(() => {
  const block = selectedStoredBlock.value;
  return block && 'budgetPriority' in block ? block as BudgetedContextBlock : null;
});
const selectedBlockGuide = computed(() => {
  const type = selectedBlockType.value;
  if (!type || type === 'role') return null;
  return contextBlockGuides[type as GuidedContextBlockType];
});
const selectedBlockRule = computed(() => (
  selectedBlockType.value === 'role'
    ? 'Role preset 按消息原顺序展开，并组成模型输入的开头。'
    : selectedBlockGuide.value?.summary ?? ''
));
const selectedBudgetLimitLabel = computed(() => {
  const block = selectedBudgetBlock.value;
  if (!block) return '';
  if (block.type === 'chatHistory') return '历史 Token 上限';
  if (block.type === 'requestDocuments') return '文档 Token 上限';
  if (block.type === 'lore') return 'Lore Token 上限';
  if (block.type === 'authorsNote') return '作者注 Token 上限';
  if (block.type === 'knowledge') return '知识 Token 上限';
  return 'Scratchpad Token 上限';
});
const selectedTokenLimitChoice = computed<TokenLimitChoice>({
  get() {
    const block = selectedBudgetBlock.value;
    if (!block) return 'auto';
    if (customTokenLimitBlockId.value === block.id) return 'custom';
    if (block.maxTokens === null) return 'auto';
    const preset = String(block.maxTokens);
    return preset === '1024' || preset === '2048' || preset === '4096' || preset === '8192'
      ? preset
      : 'custom';
  },
  set(choice) {
    const block = selectedBudgetBlock.value;
    if (!block) return;
    if (choice === 'custom') {
      customTokenLimitBlockId.value = block.id;
      if (block.maxTokens === null) block.maxTokens = 1024;
      return;
    }
    if (customTokenLimitBlockId.value === block.id) customTokenLimitBlockId.value = '';
    block.maxTokens = choice === 'auto' ? null : Number(choice);
  },
});

const selectedRoleBlock = computed<RoleContextBlock | null>(() => (
  selectedStoredBlock.value?.type === 'role' ? selectedStoredBlock.value : null
));
const selectedLoreBlock = computed<LoreContextBlock | null>(() => (
  selectedStoredBlock.value?.type === 'lore' ? selectedStoredBlock.value : null
));
const selectedAuthorsNoteBlock = computed<AuthorsNoteContextBlock | null>(() => (
  selectedStoredBlock.value?.type === 'authorsNote' ? selectedStoredBlock.value : null
));
const selectedKnowledgeBlock = computed<KnowledgeContextBlock | null>(() => (
  selectedStoredBlock.value?.type === 'knowledge' ? selectedStoredBlock.value : null
));
const selectedOutputBlock = computed<ModelOutputContextBlock | null>(() => (
  selectedStoredBlock.value?.type === 'modelOutput' ? selectedStoredBlock.value : null
));
const roleBlock = computed<RoleContextBlock | null>(() => (
  contextDraft.value?.blocks.find((block): block is RoleContextBlock => block.type === 'role') ?? null
));
const addableTypes = computed<EditableStoredContextBlockType[]>(() => {
  const draft = contextDraft.value;
  if (!draft) return [];
  const present = new Set(draft.blocks.map((block) => block.type));
  const result: EditableStoredContextBlockType[] = ['lore', 'authorsNote', 'knowledge'];
  for (const type of ['chatHistory', 'requestDocuments'] as const) {
    if (!present.has(type)) result.push(type);
  }
  if (!present.has('agentScratchpad')) result.push('agentScratchpad');
  return result;
});
const canDuplicateSelected = computed(() => (
  selectedStoredBlock.value?.type === 'lore'
  || selectedStoredBlock.value?.type === 'authorsNote'
  || selectedStoredBlock.value?.type === 'knowledge'
));
const canRemoveSelected = computed(() => {
  const type = selectedStoredBlock.value?.type;
  return type === 'lore'
    || type === 'authorsNote'
    || type === 'knowledge'
    || type === 'chatHistory'
    || type === 'requestDocuments'
    || type === 'agentScratchpad';
});

interface ContextToolRow {
  name: string;
  title: string;
  description: string;
  registered: boolean;
  enabled: boolean;
  main: boolean;
  management: 'editable' | 'locked_off';
  managementNote?: string;
  mcpTool?: AgentMcpToolAdmin;
}

const contextToolRows = computed<ContextToolRow[]>(() => {
  const query = agentToolQuery.value.trim().toLowerCase();
  const runtimeTools = new Map(
    (agentState.value?.tools.catalog ?? []).map((tool) => [tool.name, tool]),
  );
  const mcpTools = new Map(
    (agentState.value?.mcp.tools ?? []).map((tool) => [tool.name, tool]),
  );
  return (agentToolPolicy.value?.catalog ?? [])
    .filter((entry) => entry.visibility === 'standalone')
    .map((entry): ContextToolRow => ({
      name: entry.toolName,
      title: entry.title || entry.toolName,
      description: entry.description,
      registered: entry.registered ?? runtimeTools.has(entry.toolName),
      enabled: runtimeTools.get(entry.toolName)?.enabled ?? false,
      main: runtimeTools.get(entry.toolName)?.main ?? false,
      management: entry.management,
      managementNote: entry.managementNote,
      mcpTool: mcpTools.get(entry.toolName),
    }))
    .filter((tool) => (
      !query || `${tool.title} ${tool.name} ${tool.description}`.toLowerCase().includes(query)
    ))
    .sort((left, right) => left.title.localeCompare(right.title));
});

interface SelectedContextPayload extends ContextPayloadExample {
  channel: 'messages[]' | 'tools[]' | 'request options';
}

function renderPayloadTemplate(source: string): string {
  const variables: Record<string, string> = {
    name: roleDraft.value?.displayName ?? 'Sakiko',
    sender_id: '10001',
    sender: '小明',
    prompt: '请总结这个文件，并解释第二张图。',
    date: '2026-08-01 13:42:18',
    time: '13:42:18',
    weekday: '星期六',
    user_id: '10001',
    user: '小明',
    platform: 'onebot',
    group_id: '778899',
    group_name: 'Agent 设计讨论',
    bot_id: '123456',
    is_group: 'true',
    is_private: 'false',
    idle_duration: '2 分钟',
    noop: '',
  };
  let rendered = source;
  for (const [name, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{${name}}`, value);
  }
  return rendered;
}

function roleContentForPreview(content: RolePresetMessage['content']): unknown {
  if (typeof content === 'string') return renderPayloadTemplate(content);
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: renderPayloadTemplate(part.text) };
    if (part.type === 'image') {
      return {
        type: 'image_url',
        image_url: { url: part.url, detail: part.detail },
      };
    }
    if (part.type === 'file') {
      return {
        type: 'file_url',
        file_url: { url: part.url, mimeType: part.mimeType },
      };
    }
    if (part.type === 'audio') {
      return {
        type: 'audio_url',
        audio_url: { url: part.url, mimeType: part.mimeType },
      };
    }
    return {
      type: 'video_url',
      video_url: { url: part.url, mimeType: part.mimeType },
    };
  });
}

const selectedContextPayload = computed<SelectedContextPayload | null>(() => {
  const type = selectedBlockType.value;
  if (!type) return null;

  if (type === 'role') {
    const messages = roleDraft.value?.messages.map((message) => ({
      role: message.role === 'user' ? 'human' : message.role === 'assistant' ? 'ai' : 'system',
      content: roleContentForPreview(message.content),
    })) ?? [];
    return {
      channel: 'messages[]',
      meta: `messages[${messages.length}]`,
      roles: [...new Set(messages.map((message) => message.role))],
      value: messages,
    };
  }

  if (type === 'chatHistory') {
    const enabled = selectedStoredBlock.value?.type === 'chatHistory' && selectedStoredBlock.value.enabled;
    return enabled
      ? { channel: 'messages[]', ...chatHistoryExample }
      : { channel: 'messages[]', meta: 'messages[0]', roles: chatHistoryExample.roles, value: [] };
  }

  if (type === 'requestDocuments') {
    const enabled = selectedStoredBlock.value?.type === 'requestDocuments' && selectedStoredBlock.value.enabled;
    return enabled
      ? { channel: 'messages[]', ...requestDocumentExample }
      : { channel: 'messages[]', meta: 'messages[0]', roles: requestDocumentExample.roles, value: [] };
  }

  if (type === 'qqbotFragments') {
    const source = runtimeInstructionExample.value as unknown[];
    const messages = [source[0], source[1], source[2]];
    if (fragmentPolicyDraft.value?.relationshipState !== false) messages.push(source[3]);
    if (fragmentPolicyDraft.value?.attachmentReferences !== false) messages.push(source[4]);
    if (fragmentPolicyDraft.value?.nativeCapabilities !== false) messages.push(source[5]);
    return {
      channel: 'messages[]',
      meta: `messages[${messages.length}]`,
      roles: runtimeInstructionExample.roles,
      value: messages,
    };
  }

  if (type === 'toolDefinitions') {
    return { channel: 'tools[]', ...toolDefinitionsExample };
  }

  if (type === 'currentInput') {
    const block = selectedStoredBlock.value;
    if (block?.type !== 'currentInput' || block.inputFormat === null) {
      return { channel: 'messages[]', ...currentInputExample };
    }
    return {
      channel: 'messages[]',
      meta: currentInputExample.meta,
      roles: currentInputExample.roles,
      value: [
        {
          role: 'human',
          content: [
            {
              type: 'text',
              text: renderPayloadTemplate(block.inputFormat),
            },
            {
              type: 'file_url',
              file_url: {
                url: 'qqbot-file://att_pdf01/需求说明.pdf',
                mimeType: 'application/pdf',
              },
            },
          ],
        },
      ],
    };
  }

  if (type === 'agentScratchpad') {
    const enabled = selectedStoredBlock.value?.type === 'agentScratchpad' && selectedStoredBlock.value.enabled;
    return enabled
      ? { channel: 'messages[]', ...agentScratchpadExample }
      : { channel: 'messages[]', meta: 'messages[0]', roles: agentScratchpadExample.roles, value: [] };
  }

  if (type === 'modelOutput') {
    const block = selectedOutputBlock.value;
    return block
      ? {
          channel: 'request options',
          meta: modelOutputExample.meta,
          roles: modelOutputExample.roles,
          value: {
            maxOutputTokens: block.maxOutputTokens,
            postHandler: block.postHandler,
          },
        }
      : { channel: 'request options', ...modelOutputExample };
  }

  if (type === 'lore') {
    const block = selectedLoreBlock.value;
    const entries = block?.enabled
      ? block.entries.filter((entry) => entry.enabled !== false)
      : [];
    const content = entries.map((entry) => renderPayloadTemplate(entry.content)).join('\n');
    const messages = content
      ? [{
          role: 'human',
          content: renderPayloadTemplate((block?.prompt ?? '{input}').replaceAll('{input}', content)),
        }]
      : [];
    return {
      channel: 'messages[]',
      meta: `messages[${messages.length}]`,
      roles: ['human'],
      value: messages,
    };
  }

  if (type === 'authorsNote') {
    const block = selectedAuthorsNoteBlock.value;
    const messages = block?.enabled && block.insertFrequency > 0
      ? [{ role: 'human', content: renderPayloadTemplate(block.content) }]
      : [];
    return {
      channel: 'messages[]',
      meta: `messages[${messages.length}]`,
      roles: ['human'],
      value: messages,
    };
  }

  const block = selectedKnowledgeBlock.value;
  if (!block?.enabled || block.sources.length === 0) {
    return { channel: 'messages[]', meta: 'messages[0]', roles: ['human'], value: [] };
  }
  const document = `<doc metadata="${JSON.stringify({ source: block.sources[0], blockId: block.id })}" id="knowledge-01">Agent 页面使用单一工作区，并在上下文块旁直接提供相关配置。</doc>`;
  return {
    channel: 'messages[]',
    meta: 'messages[1]',
    roles: ['human'],
    value: [{
      role: 'human',
      content: renderPayloadTemplate((block.prompt ?? defaultKnowledgePrompt).replaceAll('{knowledge}', document)),
    }],
  };
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function blockPlacement(type: ResolvedContextBlock['type']): string {
  return type === 'role'
    ? '消息开头'
    : contextBlockGuides[type as GuidedContextBlockType].placement;
}

function blockOrderLabel(type: ResolvedContextBlock['type'], index: number): string {
  if (type === 'toolDefinitions') return '↗';
  const parallelBefore = preview.value?.blocks
    .slice(0, index)
    .filter((block) => block.type === 'toolDefinitions').length ?? 0;
  return String(index + 1 - parallelBefore).padStart(2, '0');
}

function apiErrorDetails(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object') return null;
  return error.details as Record<string, unknown>;
}

function uniqueBlockId(prefix: string): string {
  const ids = new Set(contextDraft.value?.blocks.map((block) => block.id) ?? []);
  if (!ids.has(prefix)) return prefix;
  let suffix = 2;
  while (ids.has(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
}

function currentRolePresetId(definition = contextDraft.value): string | null {
  return definition?.blocks.find((block): block is RoleContextBlock => block.type === 'role')
    ?.rolePresetId ?? null;
}

async function refreshCatalogs(): Promise<void> {
  const [contexts, roles] = await Promise.all([listContextPresets(), listRolePresets()]);
  contextCatalog.value = contexts;
  roleCatalog.value = roles;
}

async function loadAgentTools(): Promise<void> {
  if (agentToolsLoading.value) return;
  agentToolsLoading.value = true;
  try {
    const [state, policy] = await Promise.all([
      rawApi<AgentAdminState>('/agent'),
      rawApi<AgentToolPolicyState>('/agent/tools/policy'),
    ]);
    agentState.value = state;
    agentToolPolicy.value = policy;
  } catch (error) {
    ElMessage.error(errorText(error));
  } finally {
    agentToolsLoading.value = false;
  }
}

function contextToolState(tool: ContextToolRow): string {
  if (tool.management === 'locked_off') return tool.managementNote ?? '策略锁定关闭';
  if (!tool.registered) return '未注册';
  return tool.enabled && tool.main ? '已启用' : '已停用';
}

async function toggleContextTool(tool: ContextToolRow, enabled: boolean): Promise<void> {
  if (!tool.registered || tool.management === 'locked_off' || pendingAgentTool.value) return;
  pendingAgentTool.value = tool.name;
  try {
    if (tool.mcpTool) {
      await rawApi(`/agent/mcp/tools/${encodeURIComponent(tool.name)}`, {
        method: 'PUT',
        body: jsonBody(agentMcpToolPutSchema, {
          enabled,
          timeout: tool.mcpTool.timeout,
          selector: tool.mcpTool.selector,
        }),
      });
    } else {
      await rawApi(`/agent/tools/${encodeURIComponent(tool.name)}`, {
        method: 'PATCH',
        body: jsonBody(agentToolPutSchema, { enabled, main: enabled }),
      });
    }
    const state = await rawApi<AgentAdminState>('/agent');
    agentState.value = state;
    ElMessage.success(enabled ? `${tool.title} 已启用` : `${tool.title} 已停用`);
  } catch (error) {
    ElMessage.error(errorText(error));
  } finally {
    pendingAgentTool.value = '';
  }
}

async function loadRole(id: string): Promise<void> {
  const detail = await getRolePreset(id);
  roleDetail.value = detail;
  roleDraft.value = clone(detail.rolePreset);
  savedRoleText.value = JSON.stringify(detail.rolePreset);
}

async function loadContext(id: string): Promise<void> {
  loading.value = true;
  preview.value = null;
  previewError.value = null;
  try {
    const [detail, policy] = await Promise.all([
      getContextPreset(id),
      getPromptFragmentPolicy(id),
    ]);
    contextDetail.value = detail;
    contextDraft.value = clone(detail.contextPreset);
    savedContextText.value = JSON.stringify(detail.contextPreset);
    fragmentPolicyState.value = policy;
    fragmentPolicyDraft.value = clone(policy.config);
    savedFragmentPolicyText.value = JSON.stringify(policy.config);
    selectedContextId.value = id;
    selectedBlockId.value = detail.contextPreset.blocks[0]?.id ?? '';
    const roleId = currentRolePresetId(detail.contextPreset);
    if (roleId) await loadRole(roleId);
    await requestPreview();
  } finally {
    loading.value = false;
  }
}

async function initialize(): Promise<void> {
  loading.value = true;
  try {
    await refreshCatalogs();
    const preferred = contextCatalog.value?.globalDefaultContextPresetId
      ?? contextCatalog.value?.contextPresets[0]?.id;
    if (preferred) await loadContext(preferred);
  } catch (error) {
    ElMessage.error(errorText(error));
  } finally {
    loading.value = false;
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!hasDirtyResources.value) return true;
  try {
    await ElMessageBox.confirm(
      '当前上下文、角色或 QQBot 片段仍有未保存更改，继续会丢弃这些草稿。',
      '未保存的资源',
      { type: 'warning', confirmButtonText: '丢弃并继续', cancelButtonText: '留在当前页' },
    );
    return true;
  } catch {
    return false;
  }
}

async function selectContext(value: string | number | boolean | undefined): Promise<void> {
  const id = String(value ?? '');
  if (!id || id === selectedContextId.value) return;
  if (!await confirmDiscard()) return;
  try {
    await loadContext(id);
  } catch (error) {
    ElMessage.error(errorText(error));
  }
}

async function requestPreview(scheduledSequence?: number): Promise<void> {
  const definition = contextDraft.value;
  if (!definition) return;
  if (scheduledSequence === undefined && previewTimer !== undefined) {
    window.clearTimeout(previewTimer);
    previewTimer = undefined;
  }
  const sequence = scheduledSequence ?? ++previewSequence;
  previewError.value = null;
  try {
    const result = await previewContextPreset(clone(definition));
    if (sequence !== previewSequence) return;
    preview.value = result;
    if (!result.blocks.some((block) => block.id === selectedBlockId.value)) {
      selectedBlockId.value = result.blocks[0]?.id ?? '';
    }
  } catch (error) {
    if (sequence !== previewSequence) return;
    previewError.value = {
      message: errorText(error),
      details: apiErrorDetails(error),
    };
  }
}

function schedulePreview(): void {
  previewError.value = null;
  if (previewTimer !== undefined) window.clearTimeout(previewTimer);
  const sequence = ++previewSequence;
  previewTimer = window.setTimeout(() => {
    previewTimer = undefined;
    void requestPreview(sequence);
  }, 220);
}

async function saveContext(): Promise<boolean> {
  if (!contextDraft.value || !contextDetail.value) return false;
  savingContext.value = true;
  try {
    const detail = await updateContextPreset(
      contextDetail.value.contextPreset.id,
      clone(contextDraft.value),
      contextDetail.value.revision,
    );
    contextDetail.value = detail;
    contextDraft.value = clone(detail.contextPreset);
    savedContextText.value = JSON.stringify(detail.contextPreset);
    await refreshCatalogs();
    await requestPreview();
    ElMessage.success('上下文预设已保存');
    return true;
  } catch (error) {
    ElMessage.error(errorText(error));
    return false;
  } finally {
    savingContext.value = false;
  }
}

async function saveRole(): Promise<boolean> {
  if (!roleDraft.value || !roleDetail.value) return false;
  savingRole.value = true;
  try {
    const detail = await updateRolePreset(
      roleDetail.value.rolePreset.id,
      clone(roleDraft.value),
      roleDetail.value.revision,
    );
    roleDetail.value = detail;
    roleDraft.value = clone(detail.rolePreset);
    savedRoleText.value = JSON.stringify(detail.rolePreset);
    await refreshCatalogs();
    await requestPreview();
    ElMessage.success(`角色已保存，${detail.referenceCount} 个上下文会使用新内容`);
    return true;
  } catch (error) {
    ElMessage.error(errorText(error));
    return false;
  } finally {
    savingRole.value = false;
  }
}

async function saveFragmentPolicy(): Promise<boolean> {
  const state = fragmentPolicyState.value;
  const draft = fragmentPolicyDraft.value;
  if (!state || !draft) return false;
  savingFragmentPolicy.value = true;
  try {
    const saved = await updatePromptFragmentPolicy(
      state.contextPresetId,
      state.revision,
      clone(draft),
    );
    fragmentPolicyState.value = saved;
    fragmentPolicyDraft.value = clone(saved.config);
    savedFragmentPolicyText.value = JSON.stringify(saved.config);
    ElMessage.success('QQBot 片段设置已保存');
    return true;
  } catch (error) {
    ElMessage.error(errorText(error));
    return false;
  } finally {
    savingFragmentPolicy.value = false;
  }
}

async function resetFragmentPolicy(): Promise<void> {
  const state = fragmentPolicyState.value;
  if (!state) return;
  try {
    await ElMessageBox.confirm(
      '恢复三个可选片段的默认开启状态？',
      '恢复默认设置',
      { confirmButtonText: '恢复默认', cancelButtonText: '取消' },
    );
    savingFragmentPolicy.value = true;
    const reset = await resetPromptFragmentPolicy(
      state.contextPresetId,
      state.revision,
    );
    fragmentPolicyState.value = reset;
    fragmentPolicyDraft.value = clone(reset.config);
    savedFragmentPolicyText.value = JSON.stringify(reset.config);
    ElMessage.success('已恢复默认设置');
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(errorText(error));
  } finally {
    savingFragmentPolicy.value = false;
  }
}

async function saveDirtyResources(): Promise<void> {
  if (roleDirty.value && !await saveRole()) return;
  if (contextDirty.value && !await saveContext()) return;
  if (fragmentPolicyDirty.value) await saveFragmentPolicy();
}

async function discardDirtyResources(): Promise<void> {
  if (!hasDirtyResources.value || !await confirmDiscard()) return;
  if (selectedContextId.value) await loadContext(selectedContextId.value);
}

async function createContext(): Promise<void> {
  if (!await confirmDiscard()) return;
  try {
    const { value } = await ElMessageBox.prompt(
      '使用小写字母、数字和短横线，例如 research-assistant。',
      '新建上下文预设 ID',
      { inputPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, inputErrorMessage: 'ID 格式无效' },
    );
    const id = value.trim();
    const roleId = roleSummaries.value[0]?.id;
    if (!roleId) throw new Error('需要先存在至少一个角色预设。');
    const definition: ContextPresetDefinitionV1 = {
      schemaVersion: 1,
      id,
      displayName: id,
      aliases: [],
      blocks: [
        { id: 'role', type: 'role', rolePresetId: roleId },
        {
          id: 'chat-history',
          type: 'chatHistory',
          enabled: true,
          budgetPriority: 100,
          maxTokens: null,
        },
        {
          id: 'request-documents',
          type: 'requestDocuments',
          enabled: true,
          budgetPriority: 50,
          maxTokens: null,
        },
        { id: 'current-input', type: 'currentInput', inputFormat: null },
        {
          id: 'agent-scratchpad',
          type: 'agentScratchpad',
          enabled: true,
          budgetPriority: 400,
          maxTokens: null,
          reActInstruction: null,
        },
        { id: 'model-output', type: 'modelOutput', maxOutputTokens: 1024, postHandler: null },
      ],
    };
    const detail = await createContextPreset(definition);
    await refreshCatalogs();
    await loadContext(detail.contextPreset.id);
    ElMessage.success('上下文预设已创建');
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(errorText(error));
  }
}

async function removeCurrentContext(): Promise<void> {
  if (!contextDetail.value) return;
  try {
    await ElMessageBox.confirm(
      `永久删除运行时上下文 ${contextDetail.value.contextPreset.displayName}？`,
      '删除上下文预设',
      { type: 'warning' },
    );
    mutating.value = true;
    await deleteContextPreset(contextDetail.value.contextPreset.id, contextDetail.value.revision);
    await refreshCatalogs();
    const next = contextSummaries.value[0]?.id;
    if (next) await loadContext(next);
    ElMessage.success('上下文预设已删除');
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(errorText(error));
  } finally {
    mutating.value = false;
  }
}

async function revertCurrentContext(): Promise<void> {
  if (!contextDetail.value) return;
  try {
    await ElMessageBox.confirm('删除运行时 override 并恢复 bundled 上下文？', '恢复 bundled 版本', {
      type: 'warning',
    });
    mutating.value = true;
    const detail = await deleteContextPresetOverride(
      contextDetail.value.contextPreset.id,
      contextDetail.value.revision,
    );
    contextDetail.value = detail;
    contextDraft.value = clone(detail.contextPreset);
    savedContextText.value = JSON.stringify(detail.contextPreset);
    await refreshCatalogs();
    await requestPreview();
    ElMessage.success('已恢复 bundled 上下文');
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(errorText(error));
  } finally {
    mutating.value = false;
  }
}

async function makeDefault(): Promise<void> {
  if (!contextDetail.value) return;
  mutating.value = true;
  try {
    await setDefaultContextPreset(contextDetail.value.contextPreset.id);
    await refreshCatalogs();
    ElMessage.success('全局默认上下文已更新');
  } catch (error) {
    ElMessage.error(errorText(error));
  } finally {
    mutating.value = false;
  }
}

async function changeRoleReference(value: string | number | boolean | undefined): Promise<void> {
  const id = String(value ?? '');
  if (!id || !selectedRoleBlock.value || id === selectedRoleBlock.value.rolePresetId) return;
  if (roleDirty.value && !await confirmDiscard()) return;
  selectedRoleBlock.value.rolePresetId = id;
  try {
    await loadRole(id);
  } catch (error) {
    ElMessage.error(errorText(error));
  }
}

async function forkRole(): Promise<void> {
  if (!roleDraft.value || !selectedRoleBlock.value) return;
  try {
    const { value } = await ElMessageBox.prompt(
      '新角色保存后只会被当前上下文草稿引用。',
      '另存为新角色',
      { inputPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, inputErrorMessage: 'ID 格式无效' },
    );
    const id = value.trim();
    const definition: RolePresetDefinitionV1 = {
      ...clone(roleDraft.value),
      id,
      displayName: `${roleDraft.value.displayName} 副本`,
    };
    const detail = await createRolePreset(definition);
    selectedRoleBlock.value.rolePresetId = id;
    roleDetail.value = detail;
    roleDraft.value = clone(detail.rolePreset);
    savedRoleText.value = JSON.stringify(detail.rolePreset);
    await refreshCatalogs();
    ElMessage.success('新角色已保存；当前上下文引用仍待保存');
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(errorText(error));
  }
}

async function removeCurrentRole(): Promise<void> {
  if (!roleDetail.value) return;
  try {
    await ElMessageBox.confirm(
      `删除角色 ${roleDetail.value.rolePreset.displayName}？引用冲突会由服务端拒绝。`,
      '删除角色预设',
      { type: 'warning' },
    );
    await deleteRolePreset(roleDetail.value.rolePreset.id, roleDetail.value.revision);
    await refreshCatalogs();
    ElMessage.success('角色预设已删除');
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    const details = apiErrorDetails(error);
    const references = Array.isArray(details?.referenceIds) ? details.referenceIds.join('、') : '';
    ElMessage.error(references ? `${errorText(error)}：${references}` : errorText(error));
  }
}

async function revertCurrentRole(): Promise<void> {
  if (!roleDetail.value) return;
  try {
    await ElMessageBox.confirm('删除角色 override，并让所有引用者恢复 bundled 内容？', '恢复 bundled 角色', {
      type: 'warning',
    });
    const detail = await deleteRolePresetOverride(
      roleDetail.value.rolePreset.id,
      roleDetail.value.revision,
    );
    roleDetail.value = detail;
    roleDraft.value = clone(detail.rolePreset);
    savedRoleText.value = JSON.stringify(detail.rolePreset);
    await refreshCatalogs();
    await requestPreview();
    ElMessage.success('已恢复 bundled 角色');
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(errorText(error));
  }
}

function insertionIndex(type: EditableStoredContextBlockType): number {
  const draft = contextDraft.value;
  if (!draft) return 0;
  const input = draft.blocks.findIndex((block) => block.type === 'currentInput');
  let loreEnd = 1;
  while (draft.blocks[loreEnd]?.type === 'lore') loreEnd += 1;
  if (type === 'lore') return loreEnd;
  if (type === 'authorsNote') return input;
  const noteStart = draft.blocks.findIndex((block) => block.type === 'authorsNote');
  const upperBoundary = noteStart < 0 ? input : noteStart;
  const selected = draft.blocks.findIndex((block) => block.id === selectedBlockId.value);
  return Math.max(loreEnd, Math.min(selected < 0 ? upperBoundary : selected + 1, upperBoundary));
}

function createBlock(type: EditableStoredContextBlockType): ContextPresetBlock {
  switch (type) {
    case 'chatHistory':
      return {
        id: uniqueBlockId('chat-history'),
        type,
        enabled: true,
        budgetPriority: 100,
        maxTokens: null,
      };
    case 'requestDocuments':
      return {
        id: uniqueBlockId('request-documents'),
        type,
        enabled: true,
        budgetPriority: 50,
        maxTokens: null,
      };
    case 'lore':
      return {
        id: uniqueBlockId('lore'),
        type,
        enabled: true,
        budgetPriority: 300,
        maxTokens: null,
        prompt: null,
        defaults: {},
        entries: [],
      };
    case 'authorsNote':
      return {
        id: uniqueBlockId('authors-note'),
        type,
        enabled: true,
        budgetPriority: 320,
        maxTokens: null,
        content: '作者注内容',
        insertFrequency: 1,
      };
    case 'knowledge':
      return {
        id: uniqueBlockId('knowledge'),
        type,
        enabled: true,
        budgetPriority: 250,
        maxTokens: null,
        sources: [],
        prompt: null,
      };
    case 'agentScratchpad':
      return {
        id: uniqueBlockId('agent-scratchpad'),
        type,
        enabled: true,
        budgetPriority: 400,
        maxTokens: null,
        reActInstruction: null,
      };
    default:
      throw new Error(`不能新增 ${type} 块。`);
  }
}

function addBlock(type: EditableStoredContextBlockType): void {
  if (!contextDraft.value || !addableTypes.value.includes(type)) return;
  const block = createBlock(type);
  const index = type === 'agentScratchpad'
    ? contextDraft.value.blocks.findIndex((item) => item.type === 'modelOutput')
    : insertionIndex(type);
  contextDraft.value.blocks.splice(index, 0, block);
  selectedBlockId.value = block.id;
}

function duplicateSelectedBlock(): void {
  if (!contextDraft.value || !canDuplicateSelected.value || !selectedStoredBlock.value) return;
  const index = contextDraft.value.blocks.findIndex((block) => block.id === selectedStoredBlock.value?.id);
  const copy = clone(selectedStoredBlock.value);
  copy.id = uniqueBlockId(copy.type === 'authorsNote' ? 'authors-note' : copy.type);
  contextDraft.value.blocks.splice(index + 1, 0, copy);
  selectedBlockId.value = copy.id;
}

function removeSelectedBlock(): void {
  if (!contextDraft.value || !canRemoveSelected.value || !selectedStoredBlock.value) return;
  const index = contextDraft.value.blocks.findIndex((block) => block.id === selectedStoredBlock.value?.id);
  contextDraft.value.blocks.splice(index, 1);
  selectedBlockId.value = contextDraft.value.blocks[Math.max(0, index - 1)]?.id ?? '';
}

function resolvedFor(id: string): ResolvedContextBlock | null {
  return preview.value?.blocks.find((block) => block.id === id) ?? null;
}

function canMoveTo(blockId: string, targetStoredIndex: number): boolean {
  const resolved = resolvedFor(blockId);
  const range = resolved?.legalDropRange;
  return Boolean(resolved?.movable && range && targetStoredIndex >= range.minIndex && targetStoredIndex <= range.maxIndex);
}

function moveBlock(blockId: string, targetStoredIndex: number): void {
  const draft = contextDraft.value;
  if (!draft || !canMoveTo(blockId, targetStoredIndex)) return;
  const from = draft.blocks.findIndex((block) => block.id === blockId);
  if (from < 0 || from === targetStoredIndex) return;
  const [block] = draft.blocks.splice(from, 1);
  draft.blocks.splice(targetStoredIndex, 0, block);
  selectedBlockId.value = block.id;
}

function moveSelectedBy(delta: number): void {
  const draft = contextDraft.value;
  if (!draft || !selectedStoredBlock.value) return;
  const index = draft.blocks.findIndex((block) => block.id === selectedStoredBlock.value?.id);
  moveBlock(selectedStoredBlock.value.id, index + delta);
}

function moveBlockByKeyboard(block: ResolvedContextBlock, delta: number): void {
  if (!block.movable) return;
  selectedBlockId.value = block.id;
  moveSelectedBy(delta);
}

function dragStart(block: ResolvedContextBlock, event: DragEvent): void {
  if (!block.movable) {
    event.preventDefault();
    return;
  }
  draggingBlockId.value = block.id;
  event.dataTransfer?.setData('text/plain', block.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function dragOver(block: ResolvedContextBlock, event: DragEvent): void {
  const id = draggingBlockId.value;
  if (!id || block.source !== 'stored' || !contextDraft.value) return;
  const index = contextDraft.value.blocks.findIndex((item) => item.id === block.id);
  if (canMoveTo(id, index)) event.preventDefault();
}

function dropOn(block: ResolvedContextBlock, event: DragEvent): void {
  event.preventDefault();
  const id = draggingBlockId.value ?? event.dataTransfer?.getData('text/plain');
  draggingBlockId.value = null;
  if (!id || block.source !== 'stored' || !contextDraft.value) return;
  const index = contextDraft.value.blocks.findIndex((item) => item.id === block.id);
  moveBlock(id, index);
}

function setBlockMaxTokens(value: number | undefined): void {
  if (!selectedBudgetBlock.value) return;
  selectedBudgetBlock.value.maxTokens = typeof value === 'number' && value > 0 ? value : null;
}

function setKnowledgeSources(value: string): void {
  if (!selectedKnowledgeBlock.value) return;
  selectedKnowledgeBlock.value.sources = value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function knowledgeSourcesText(block: KnowledgeContextBlock): string {
  return block.sources.join('\n');
}

function setPostHandlerEnabled(enabled: boolean): void {
  if (!selectedOutputBlock.value) return;
  selectedOutputBlock.value.postHandler = enabled
    ? { id: 'default', prefix: '', postfix: '', variables: {} }
    : null;
}

function postVariablesText(block: ModelOutputContextBlock): string {
  return JSON.stringify(block.postHandler?.variables ?? {}, null, 2);
}

function setPostVariables(value: string): void {
  if (!selectedOutputBlock.value?.postHandler) return;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    selectedOutputBlock.value.postHandler.variables = Object.fromEntries(
      Object.entries(parsed).map(([key, item]) => [key, String(item)]),
    );
  } catch {
    ElMessage.error('variables 必须是 JSON object');
  }
}

function addRoleMessage(): void {
  roleDraft.value?.messages.push({ role: 'system', content: '新角色说明' });
}

function removeRoleMessage(index: number): void {
  roleDraft.value?.messages.splice(index, 1);
}

function setComplexMessageContent(index: number, value: string): void {
  const message = roleDraft.value?.messages[index];
  if (!message || typeof message.content === 'string') return;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error();
    message.content = parsed as RolePresetMessage['content'];
  } catch {
    ElMessage.error('多模态 content 必须是 JSON array');
  }
}

function addLoreEntry(): void {
  selectedLoreBlock.value?.entries.push({
    keywords: ['关键词'],
    content: 'Lore 内容',
    enabled: true,
  });
}

function setLoreKeywords(index: number, value: string): void {
  const entry = selectedLoreBlock.value?.entries[index];
  if (!entry) return;
  entry.keywords = value.split(',').map((item) => item.trim()).filter(Boolean);
}

function previewErrorMeta(): string {
  const details = previewError.value?.details;
  if (!details) return '';
  return [
    details.stage ? `stage=${String(details.stage)}` : '',
    details.blockId ? `block=${String(details.blockId)}` : '',
    details.limit != null ? `limit=${String(details.limit)}` : '',
  ].filter(Boolean).join(' · ');
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!hasDirtyResources.value) return;
  event.preventDefault();
  event.returnValue = '';
}

watch(contextDraft, schedulePreview, { deep: true });
watch(selectedBlockType, (type) => {
  if (type === 'toolDefinitions' && agentState.value === null) void loadAgentTools();
});

onBeforeRouteLeave(async () => {
  if (!hasDirtyResources.value) return true;
  return confirmDiscard();
});

onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('admin-save', saveDirtyResources);
  void initialize();
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('admin-save', saveDirtyResources);
  if (previewTimer !== undefined) window.clearTimeout(previewTimer);
});
</script>

<template>
  <div class="context-workbench">
    <header class="context-page-head">
      <div>
        <h1>上下文</h1>
        <p>按输入顺序排列；选择一项即可编辑。</p>
      </div>
      <div class="context-budget">
        <span>Input <strong>{{ preview?.inputBudgetTokens ?? 'runtime' }}</strong></span>
        <span>Output <strong>{{ preview?.outputBudgetTokens ?? '—' }}</strong></span>
      </div>
    </header>

    <section class="preset-bar">
      <div class="preset-picker">
        <span class="picker-label">模板</span>
        <el-select
          :model-value="selectedContextId"
          filterable
          :loading="loading"
          aria-label="选择上下文预设"
          @change="selectContext"
        >
          <el-option v-for="item in contextSummaries" :key="item.id" :value="item.id" :label="item.displayName" />
        </el-select>
      </div>
      <div class="preset-actions-inline">
        <span v-if="contextCatalog?.globalDefaultContextPresetId === selectedContextId" class="preset-status">全局默认</span>
        <el-button text @click="createContext">新建</el-button>
        <el-button
          v-if="contextCatalog?.globalDefaultContextPresetId !== selectedContextId"
          text
          :disabled="!selectedContextId || contextCatalog?.globalDefaultContextPresetId === selectedContextId"
          :loading="mutating"
          @click="makeDefault"
        >
          设为默认
        </el-button>
        <el-button
          v-if="contextDetail?.hasOverride"
          text
          :loading="mutating"
          @click="revertCurrentContext"
        >
          恢复 bundled
        </el-button>
        <el-button
          v-if="contextDetail?.source === 'runtime' && !contextDetail.hasOverride"
          text
          type="danger"
          :disabled="!contextDetail || contextDetail.source !== 'runtime' || contextDetail.hasOverride"
          :loading="mutating"
          @click="removeCurrentContext"
        >
          删除
        </el-button>
      </div>
    </section>

    <div v-if="contextDraft" class="workbench-grid">
      <section class="stack-panel" aria-label="上下文输入顺序">
        <div v-if="previewError" class="preview-error" role="alert">
          <strong>草稿无法编译</strong>
          <span>{{ previewError.message }}</span>
          <code v-if="previewErrorMeta()">{{ previewErrorMeta() }}</code>
        </div>
        <div v-else-if="!preview" class="stack-loading">
          正在解析草稿…
        </div>
        <div v-else class="context-stack">
          <article
            v-for="(block, index) in preview.blocks"
            :key="block.id"
            class="stack-block"
            :class="{
              selected: block.id === selectedBlockId,
              disabled: !block.enabled,
              runtime: block.source === 'runtime',
              dragging: block.id === draggingBlockId,
            }"
            :draggable="block.movable"
            tabindex="0"
            :aria-label="`${blockLabels[block.type]}${block.enabled ? '' : '，已停用'}`"
            @click="selectedBlockId = block.id"
            @focus="selectedBlockId = block.id"
            @keydown.up.prevent="moveBlockByKeyboard(block, -1)"
            @keydown.down.prevent="moveBlockByKeyboard(block, 1)"
            @dragstart="dragStart(block, $event)"
            @dragover="dragOver(block, $event)"
            @drop="dropOn(block, $event)"
            @dragend="draggingBlockId = null"
          >
            <span class="stack-index">{{ blockOrderLabel(block.type, index) }}</span>
            <span class="stack-copy">
              <strong>{{ blockLabels[block.type] }}</strong>
              <small>{{ blockPlacement(block.type) }}</small>
            </span>
            <span v-if="!block.enabled" class="stack-state">关闭</span>
            <span v-else-if="block.source === 'runtime'" class="stack-state">Runtime</span>
          </article>
        </div>

        <div v-if="!previewError && preview" class="add-block-tray">
          <button
            v-for="type in addableTypes"
            :key="type"
            type="button"
            @click="addBlock(type)"
          >
            {{ blockLabels[type] }}
          </button>
        </div>
      </section>

      <section class="editor-panel">
        <div class="panel-head editor-head">
          <div>
            <div class="editor-title-row">
              <h2>{{ selectedBlockType ? blockLabels[selectedBlockType] : '选择一个块' }}</h2>
              <code v-if="selectedContextPayload">{{ selectedContextPayload.channel }}</code>
            </div>
            <small v-if="selectedBlockRule">{{ selectedBlockRule }}</small>
          </div>
          <div class="block-tools">
            <el-button v-if="canDuplicateSelected" size="small" @click="duplicateSelectedBlock">
              复制块
            </el-button>
            <el-button v-if="canRemoveSelected" size="small" type="danger" plain @click="removeSelectedBlock">
              移除
            </el-button>
          </div>
        </div>

        <div v-if="selectedBlockType" class="editor-body">
          <div class="context-editor-grid">
            <ContextPayloadPreview
              v-if="selectedContextPayload"
              class="context-payload"
              :value="selectedContextPayload.value"
              :meta="selectedContextPayload.meta"
              :roles="selectedContextPayload.roles"
            />

            <section class="block-settings">
              <header class="settings-head">
                <h3>配置</h3>
              </header>

              <template v-if="selectedResolvedBlock?.source === 'runtime'">
            <template v-if="selectedResolvedBlock.type === 'qqbotFragments'">
              <div class="runtime-link-row">
                <span><strong>Skills</strong><small>description / full</small></span>
                <el-button text @click="router.push('/intelligence/agent?section=skills')">管理</el-button>
              </div>
              <section v-if="fragmentPolicyDraft" class="fragment-policy">
                <div
                  v-for="channel in configurableQqbotFragmentChannels"
                  :key="channel.key"
                  class="fragment-policy-row"
                >
                  <div>
                    <strong>{{ channel.label }}</strong>
                    <p>{{ channel.description }}</p>
                  </div>
                  <el-switch
                    v-model="fragmentPolicyDraft[channel.key]"
                    :disabled="savingFragmentPolicy"
                    :aria-label="channel.label"
                  />
                </div>
                <div class="fragment-policy-actions">
                  <el-button
                    v-if="fragmentPolicyState?.source !== 'default'"
                    text
                    :loading="savingFragmentPolicy"
                    @click="resetFragmentPolicy"
                  >
                    恢复默认
                  </el-button>
                </div>
              </section>
            </template>
            <section v-else-if="selectedResolvedBlock.type === 'toolDefinitions'" class="context-tools">
              <div class="context-tools-head">
                <el-input
                  v-model="agentToolQuery"
                  clearable
                  size="small"
                  placeholder="搜索 Tools"
                  aria-label="搜索 Tools"
                />
                <el-button text @click="router.push('/intelligence/agent?section=tools')">全部</el-button>
              </div>
              <div v-loading="agentToolsLoading" class="context-tool-list">
                <article v-for="tool in contextToolRows" :key="tool.name" class="context-tool-row">
                  <div>
                    <strong>{{ tool.title }}</strong>
                    <small>{{ tool.name }}</small>
                    <span>{{ contextToolState(tool) }}</span>
                  </div>
                  <el-switch
                    :model-value="tool.enabled && tool.main"
                    :disabled="!tool.registered || tool.management === 'locked_off'"
                    :loading="pendingAgentTool === tool.name"
                    :aria-label="`${tool.enabled && tool.main ? '停用' : '启用'} ${tool.title}`"
                    @change="toggleContextTool(tool, Boolean($event))"
                  />
                </article>
                <p v-if="!agentToolsLoading && contextToolRows.length === 0" class="empty-setting">
                  {{ agentToolQuery ? '没有匹配的 Tool' : '没有可配置的 Tool' }}
                </p>
              </div>
            </section>
              </template>

              <template v-else-if="selectedStoredBlock">
            <el-form label-position="top">
              <div v-if="selectedBudgetBlock" class="budget-settings">
                <el-form-item label="启用">
                  <el-switch v-model="selectedBudgetBlock.enabled" />
                </el-form-item>
                <el-form-item :label="selectedBudgetLimitLabel">
                  <div class="token-limit-control">
                    <el-segmented
                      v-model="selectedTokenLimitChoice"
                      :options="tokenLimitOptions"
                    />
                    <el-input-number
                      v-if="selectedTokenLimitChoice === 'custom'"
                      class="custom-token-limit"
                      :model-value="selectedBudgetBlock.maxTokens"
                      :min="1"
                      controls-position="right"
                      @change="setBlockMaxTokens"
                    />
                  </div>
                </el-form-item>
              </div>

              <template v-if="selectedRoleBlock">
                <div class="role-resource-head">
                  <el-form-item label="角色">
                    <el-select
                      :model-value="selectedRoleBlock.rolePresetId"
                      filterable
                      @change="changeRoleReference"
                    >
                      <el-option
                        v-for="role in roleSummaries"
                        :key="role.id"
                        :value="role.id"
                        :label="role.displayName"
                      />
                    </el-select>
                  </el-form-item>
                </div>
                <template v-if="roleDraft">
                  <div class="subsection-head">
                    <strong>角色消息</strong>
                    <el-button size="small" @click="addRoleMessage">新增消息</el-button>
                  </div>
                  <div v-for="(message, index) in roleDraft.messages" :key="index" class="message-editor">
                    <div class="message-meta">
                      <el-select v-model="message.role" size="small">
                        <el-option label="system" value="system" />
                        <el-option label="user" value="user" />
                        <el-option label="assistant" value="assistant" />
                      </el-select>
                      <el-button text type="danger" @click="removeRoleMessage(index)">删除</el-button>
                    </div>
                    <el-input
                      v-if="typeof message.content === 'string'"
                      v-model="message.content"
                      type="textarea"
                      :autosize="{ minRows: 4, maxRows: 18 }"
                    />
                    <el-input
                      v-else
                      :model-value="JSON.stringify(message.content, null, 2)"
                      type="textarea"
                      :autosize="{ minRows: 5, maxRows: 18 }"
                      @change="setComplexMessageContent(index, $event)"
                    />
                  </div>
                  <div class="role-actions">
                    <el-button @click="forkRole">另存为新角色</el-button>
                    <el-button
                      v-if="roleDetail?.hasOverride"
                      @click="revertCurrentRole"
                    >
                      恢复 bundled
                    </el-button>
                    <el-button
                      v-if="roleDetail?.source === 'runtime' && !roleDetail.hasOverride"
                      type="danger"
                      plain
                      @click="removeCurrentRole"
                    >
                      删除角色
                    </el-button>
                  </div>
                </template>
              </template>

              <template v-else-if="selectedStoredBlock.type === 'currentInput'">
                <el-form-item label="输入格式">
                  <el-input
                    v-model="selectedStoredBlock.inputFormat"
                    type="textarea"
                    :autosize="{ minRows: 6, maxRows: 18 }"
                    placeholder="留空时使用运行时默认格式"
                  />
                </el-form-item>
                <p class="field-note">可使用运行时提供的变量，例如 <code>{prompt}</code>、<code>{date}</code>。</p>
              </template>

              <template v-else-if="selectedOutputBlock">
                <el-form-item label="最大输出 Token">
                  <el-input-number v-model="selectedOutputBlock.maxOutputTokens" :min="1" />
                </el-form-item>
                <details class="advanced-settings">
                  <summary>回复后处理</summary>
                  <p>仅在运行时已经注册对应 Handler 时启用；处理发生在模型生成回复之后。</p>
                  <el-form-item label="启用">
                    <el-switch
                      :model-value="selectedOutputBlock.postHandler !== null"
                      @change="setPostHandlerEnabled"
                    />
                  </el-form-item>
                  <div v-if="selectedOutputBlock.postHandler" class="form-grid two">
                    <el-form-item label="Handler ID">
                      <el-input v-model="selectedOutputBlock.postHandler.id" />
                    </el-form-item>
                    <el-form-item label="内容审查">
                      <el-switch v-model="selectedOutputBlock.postHandler.censor" />
                    </el-form-item>
                    <el-form-item label="回复前缀">
                      <el-input v-model="selectedOutputBlock.postHandler.prefix" />
                    </el-form-item>
                    <el-form-item label="回复后缀">
                      <el-input v-model="selectedOutputBlock.postHandler.postfix" />
                    </el-form-item>
                    <el-form-item class="wide" label="变量（JSON object）">
                      <el-input
                        :model-value="postVariablesText(selectedOutputBlock)"
                        type="textarea"
                        :autosize="{ minRows: 3, maxRows: 10 }"
                        @change="setPostVariables"
                      />
                    </el-form-item>
                  </div>
                </details>
              </template>

              <template v-else-if="selectedStoredBlock.type === 'agentScratchpad'">
                <el-form-item label="ReAct Instruction">
                  <el-input
                    v-model="selectedStoredBlock.reActInstruction"
                    type="textarea"
                    :autosize="{ minRows: 5, maxRows: 16 }"
                    placeholder="留空时使用 Agent runtime 默认协议"
                  />
                </el-form-item>
              </template>

              <template v-else-if="selectedKnowledgeBlock">
                <el-form-item label="知识来源 ID（每行一个）">
                  <el-input
                    :model-value="knowledgeSourcesText(selectedKnowledgeBlock)"
                    type="textarea"
                    :autosize="{ minRows: 4, maxRows: 12 }"
                    @input="setKnowledgeSources"
                  />
                </el-form-item>
                <el-form-item label="渲染 Prompt">
                  <el-input v-model="selectedKnowledgeBlock.prompt" type="textarea" :autosize="{ minRows: 4, maxRows: 12 }" />
                </el-form-item>
              </template>

              <template v-if="selectedAuthorsNoteBlock">
                <el-form-item label="作者注">
                  <el-input v-model="selectedAuthorsNoteBlock.content" type="textarea" :autosize="{ minRows: 6, maxRows: 18 }" />
                </el-form-item>
                <el-form-item label="每 N 轮注入（0 表示关闭）">
                  <el-input-number v-model="selectedAuthorsNoteBlock.insertFrequency" :min="0" />
                </el-form-item>
              </template>

              <template v-if="selectedLoreBlock">
                <el-form-item label="Lore 渲染 Prompt">
                  <el-input v-model="selectedLoreBlock.prompt" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" />
                </el-form-item>
                <div class="form-grid two">
                  <el-form-item label="扫描深度">
                    <el-input-number v-model="selectedLoreBlock.defaults.scanDepth" :min="0" />
                  </el-form-item>
                  <el-form-item label="递归扫描">
                    <el-switch v-model="selectedLoreBlock.defaults.recursiveScan" />
                  </el-form-item>
                  <el-form-item label="最大递归深度">
                    <el-input-number v-model="selectedLoreBlock.defaults.maxRecursionDepth" :min="0" />
                  </el-form-item>
                </div>
                <div class="subsection-head">
                  <strong>Lore 条目</strong>
                  <el-button size="small" @click="addLoreEntry">新增条目</el-button>
                </div>
                <div v-for="(entry, index) in selectedLoreBlock.entries" :key="index" class="lore-entry">
                  <div class="message-meta">
                    <el-switch v-model="entry.enabled" active-text="启用" />
                    <el-button text type="danger" @click="selectedLoreBlock.entries.splice(index, 1)">删除</el-button>
                  </div>
                  <el-input
                    :model-value="entry.keywords.join(', ')"
                    placeholder="关键词，以逗号分隔"
                    @input="setLoreKeywords(index, $event)"
                  />
                  <el-input v-model="entry.content" type="textarea" :autosize="{ minRows: 4, maxRows: 14 }" />
                </div>
              </template>

            </el-form>
              </template>
            </section>
          </div>
        </div>
        <div v-else class="editor-empty">从左侧选择一个上下文块。</div>
      </section>
    </div>

    <div v-else-if="!loading" class="panel empty-workbench">
      当前没有可编辑的上下文预设。
    </div>
    <ContextRuntimeInspector />
    <PendingChangesBar
      v-if="hasDirtyResources"
      :saving="savingContext || savingRole"
      :disabled="mutating"
      message="上下文预设有未保存修改"
      save-label="保存全部"
      @discard="discardDirtyResources"
      @save="saveDirtyResources"
    />
  </div>
</template>

<style scoped>
.context-workbench {
  min-width: 0;
  --workbench-height: clamp(560px, calc(100vh - 180px), 820px);
}

.context-page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  max-width: 1180px;
  margin: 0 auto 18px;
}

.context-page-head h1 {
  margin: 0;
  font-size: 26px;
  letter-spacing: -.03em;
}

.context-page-head p {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.context-budget {
  display: flex;
  gap: 16px;
  color: var(--muted);
  font-size: 10px;
}

.context-budget strong {
  margin-left: 4px;
  color: var(--ink);
  font-weight: 600;
}

.preset-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-height: 52px;
  max-width: 1180px;
  margin: 0 auto;
  padding: 8px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.preset-picker,
.preset-actions-inline,
.role-resource-head,
.role-actions,
.block-tools,
.inline-field,
.message-meta,
.subsection-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.preset-picker {
  min-width: 0;
  flex: 1;
}

.preset-picker .el-select {
  width: min(360px, 48vw);
}

.picker-label {
  flex: none;
  color: #657083;
  font-size: 11px;
  font-weight: 700;
}

.preset-status {
  color: var(--muted);
  font-size: 10px;
}

.workbench-grid {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  align-items: stretch;
  min-width: 0;
  max-width: 1180px;
  margin: 0 auto;
  border-bottom: 1px solid var(--line);
}

.stack-panel,
.editor-panel {
  min-width: 0;
  height: var(--workbench-height);
  overflow: hidden;
}

.stack-panel {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
}

.editor-panel {
  display: flex;
  flex-direction: column;
}

.editor-head {
  flex: none;
  min-height: 64px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
}

.editor-head h2 {
  margin: 0;
  font-size: 15px;
}

.editor-head small {
  display: block;
  margin-top: 5px;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.45;
}

.editor-title-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.editor-title-row code {
  padding: 2px 6px;
  border-radius: 5px;
  color: #7155b3;
  background: #f1ecff;
  font: 9px/1.4 var(--font-mono, ui-monospace, monospace);
}

.context-stack {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}

.stack-block {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 54px;
  padding: 7px 10px;
  border: 0;
  border-bottom: 1px solid var(--line);
  color: var(--ink);
  background: transparent;
  cursor: pointer;
  outline: none;
  transition: background-color .14s ease, color .14s ease;
}

.stack-block:hover,
.stack-block:focus-visible {
  background: color-mix(in srgb, var(--surface) 92%, var(--accent) 8%);
}

.stack-block.selected {
  color: var(--accent);
  background: color-mix(in srgb, var(--surface) 88%, var(--accent) 12%);
  box-shadow: inset 2px 0 0 var(--accent);
}

.stack-block.disabled {
  opacity: .55;
}

.stack-block.dragging {
  opacity: .55;
}

.stack-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.stack-copy strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stack-index,
.stack-copy small,
.stack-state {
  color: var(--muted);
  font-size: 9px;
}

.stack-index {
  font-family: var(--font-mono, ui-monospace, monospace);
}

.stack-state {
  text-transform: uppercase;
}

.add-block-tray {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: none;
  padding: 10px;
  border-top: 1px solid var(--line);
}

.add-block-tray button {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  color: var(--muted);
  background: transparent;
  font-size: 11px;
  cursor: pointer;
}

.add-block-tray button:hover {
  color: var(--accent);
  background: color-mix(in srgb, var(--surface) 90%, var(--accent) 10%);
}

.preview-error {
  display: grid;
  gap: 6px;
  margin: 18px;
  padding: 14px;
  border: 1px solid #f1bac2;
  border-radius: 9px;
  color: #9b3142;
  background: #fff4f5;
  font-size: 11px;
}

.preview-error code {
  color: #a0505c;
  font-size: 10px;
}

.stack-loading,
.editor-empty,
.empty-workbench {
  min-height: 180px;
  display: grid;
  place-items: center;
  color: #8b95a4;
  font-size: 12px;
}

.editor-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 18px;
  overflow: auto;
}

.context-editor-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(250px, .75fr);
  gap: 20px;
  align-items: start;
}

.context-payload,
.block-settings {
  min-width: 0;
}

.block-settings {
  padding-left: 18px;
  border-left: 1px solid var(--line);
}

.settings-head {
  min-height: 30px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0 8px;
}

.settings-head h3 {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
}

.runtime-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
}

.context-tools {
  min-width: 0;
}

.context-tools-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}

.context-tool-list {
  min-height: 54px;
  max-height: 500px;
  overflow: auto;
}

.context-tool-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 58px;
  padding: 8px 3px;
  border-bottom: 1px solid var(--line);
}

.context-tool-row > div {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 8px;
}

.context-tool-row strong,
.context-tool-row small,
.context-tool-row span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-tool-row strong {
  font-size: 11px;
}

.context-tool-row small {
  color: var(--muted);
  font: 9px/1.4 var(--font-mono, ui-monospace, monospace);
}

.context-tool-row span {
  grid-column: 1 / -1;
  color: var(--muted);
  font-size: 9px;
}

.empty-setting {
  margin: 0;
  padding: 18px 2px;
  color: var(--muted);
  font-size: 10px;
}

.runtime-link-row {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border-top: 1px solid var(--line);
}

.runtime-link-row > span {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.runtime-link-row strong {
  font-size: 12px;
}

.runtime-link-row small {
  color: var(--muted);
  font-size: 10px;
}

.fragment-policy {
  border-top: 1px solid #d8e0eb;
}

.fragment-policy-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  min-height: 58px;
  padding: 8px 0;
  border-bottom: 1px solid #e2e7ef;
}

.fragment-policy-row strong {
  color: var(--ink);
  font-size: 12px;
}

.fragment-policy-row p {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 10px;
}

.fragment-policy-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 8px;
}

.advanced-settings {
  margin: 8px 0 18px;
  padding: 13px 0 0;
  border-top: 1px solid #e5e9f0;
}

.advanced-settings summary {
  width: fit-content;
  color: #34425a;
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
}

.advanced-settings > p {
  margin: 8px 0 14px;
  color: #788397;
  font-size: 10px;
  line-height: 1.65;
}

.budget-settings {
  display: grid;
  grid-template-columns: 1fr;
  min-width: 0;
  gap: 0 14px;
  align-items: start;
  margin-bottom: 8px;
}

.budget-settings .el-form-item {
  min-width: 0;
  margin-bottom: 10px;
}

.budget-settings .wide {
  grid-column: 1 / -1;
}

.token-limit-control {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.token-limit-control .el-segmented {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.token-limit-control :deep(.el-segmented__group) {
  width: 100%;
  min-width: 0;
}

.token-limit-control :deep(.el-segmented__item) {
  min-width: 0;
  flex: 1;
  padding: 0 3px;
}

.token-limit-control :deep(.el-segmented__item-label) {
  padding: 0;
  font-size: 10px;
}

.custom-token-limit {
  width: 160px;
}

.form-grid {
  display: grid;
  gap: 14px;
}

.form-grid.two {
  grid-template-columns: 1fr;
}

.form-grid .wide {
  grid-column: 1 / -1;
}

.inline-field {
  flex-wrap: wrap;
}

.role-resource-head {
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 16px;
}

.role-resource-head .el-form-item {
  min-width: 0;
  flex: 1;
  margin-bottom: 0;
}

.subsection-head {
  justify-content: space-between;
  margin: 18px 0 10px;
  padding-top: 14px;
  border-top: 1px solid #e7eaf0;
  font-size: 12px;
}

.message-editor,
.lore-entry {
  min-width: 0;
  margin-bottom: 12px;
  padding: 14px;
  border: 1px solid #e2e7ee;
  border-radius: 9px;
  background: #fafbfd;
}

.message-meta {
  margin-bottom: 9px;
}

.message-meta .el-select {
  width: 150px;
}

.message-meta .el-button {
  margin-left: auto;
}

.role-actions {
  flex-wrap: wrap;
  margin-top: 16px;
}

.field-note {
  margin: -8px 0 14px;
  color: #858f9f;
  font-size: 10px;
}

.field-note code {
  color: #4968b4;
}

.lore-entry {
  display: grid;
  gap: 9px;
}

@media (max-width: 1080px) {
  .workbench-grid {
    grid-template-columns: 188px minmax(0, 1fr);
  }

  .context-editor-grid {
    grid-template-columns: 1fr;
  }

  .block-settings {
    padding-top: 16px;
    padding-left: 0;
    border-top: 1px solid var(--line);
    border-left: 0;
  }
}

@media (max-width: 820px) {
  .context-workbench {
    --workbench-height: auto;
  }

  .preset-bar,
  .preset-picker {
    align-items: stretch;
    flex-direction: column;
  }

  .preset-picker .el-select {
    width: 100%;
  }

  .preset-actions-inline {
    justify-content: flex-end;
  }

  .workbench-grid {
    grid-template-columns: 1fr;
  }

  .stack-panel,
  .editor-panel {
    height: auto;
  }

  .context-stack {
    max-height: 520px;
    padding: 12px;
  }
}

@media (max-width: 520px) {
  .form-grid.two {
    grid-template-columns: 1fr;
  }

  .preset-actions-inline,
  .block-tools,
  .role-actions {
    width: 100%;
    align-items: stretch;
    flex-direction: column;
  }

  .budget-settings {
    grid-template-columns: 1fr;
  }

  .token-limit-control .el-segmented {
    width: 100%;
  }

  .custom-token-limit {
    width: 100%;
  }

  .editor-body {
    padding: 14px;
  }

  .role-resource-head,
  .message-meta {
    align-items: stretch;
    flex-direction: column;
  }

  .message-meta .el-select {
    width: 100%;
  }

  .message-meta .el-button {
    margin-left: 0;
  }
}
</style>
