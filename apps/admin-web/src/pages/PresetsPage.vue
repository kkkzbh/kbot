<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ApiError } from '@/api/client';
import {
  createContextPreset,
  createRolePreset,
  deleteContextPreset,
  deleteContextPresetOverride,
  deleteRolePreset,
  deleteRolePresetOverride,
  getContextPreset,
  getRolePreset,
  listContextPresets,
  listRolePresets,
  previewContextPreset,
  setDefaultContextPreset,
  updateContextPreset,
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
  chatHistoryExample,
  contextBlockGuides,
  requestAttachmentExamples,
  requestAttachmentGuides,
  requestDocumentExample,
  type GuidedContextBlockType,
} from './context-preset-guides';

type Anchor = LoreContextBlock['anchor'];
type RoleAnchor = Extract<Anchor, { type: 'role' }>;
type BlockAnchor = Extract<Anchor, { type: 'block' }>;
type HistoryAnchor = Extract<Anchor, { type: 'chatHistory' }>;
type EditableStoredContextBlockType = Exclude<StoredContextBlockType, 'longMemory'>;
type EditableContextPresetBlock = Exclude<ContextPresetBlock, { type: 'longMemory' }>;
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
const selectedBlockId = ref('');
const preview = ref<ContextPresetPreviewResponse | null>(null);
const previewError = ref<{ message: string; details: Record<string, unknown> | null } | null>(null);
const loading = ref(false);
const savingContext = ref(false);
const savingRole = ref(false);
const mutating = ref(false);
const draggingBlockId = ref<string | null>(null);
const customTokenLimitBlockId = ref('');
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
  qqbotFragments: 'QQBot Fragments',
  toolDefinitions: '工具定义',
};

const rolePositions: Array<{ value: RoleAnchor['position']; label: string }> = [
  { value: 'beforeCharacterDefinitions', label: '角色定义前' },
  { value: 'afterCharacterDefinitions', label: '角色定义后' },
  { value: 'beforeScenario', label: '场景前' },
  { value: 'afterScenario', label: '场景后' },
  { value: 'beforeExampleMessages', label: '示例消息前' },
  { value: 'afterExampleMessages', label: '示例消息后' },
];

const contextDirty = computed(() => (
  contextDraft.value !== null
  && JSON.stringify(contextDraft.value) !== savedContextText.value
));
const roleDirty = computed(() => (
  roleDraft.value !== null
  && JSON.stringify(roleDraft.value) !== savedRoleText.value
));
const hasDirtyResources = computed(() => contextDirty.value || roleDirty.value);
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
const selectedAnchorBlock = computed<LoreContextBlock | AuthorsNoteContextBlock | null>(() => (
  selectedLoreBlock.value ?? selectedAuthorsNoteBlock.value
));
const roleBlock = computed<RoleContextBlock | null>(() => (
  contextDraft.value?.blocks.find((block): block is RoleContextBlock => block.type === 'role') ?? null
));
const anchorTargetBlocks = computed<EditableContextPresetBlock[]>(() => (
  contextDraft.value?.blocks.filter(
    (block): block is EditableContextPresetBlock => (
      block.type !== 'longMemory'
      && block.type !== 'modelOutput'
      && block.id !== selectedAnchorBlock.value?.id
    ),
  ) ?? []
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    const detail = await getContextPreset(id);
    contextDetail.value = detail;
    contextDraft.value = clone(detail.contextPreset);
    savedContextText.value = JSON.stringify(detail.contextPreset);
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
      '当前上下文或共享角色仍有未保存更改，继续会丢弃这些草稿。',
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
    ElMessage.success(`共享角色已保存，${detail.referenceCount} 个上下文会使用新内容`);
    return true;
  } catch (error) {
    ElMessage.error(errorText(error));
    return false;
  } finally {
    savingRole.value = false;
  }
}

async function saveDirtyResources(): Promise<void> {
  if (roleDirty.value && !await saveRole()) return;
  if (contextDirty.value) await saveContext();
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

function insertionIndex(): number {
  const draft = contextDraft.value;
  if (!draft) return 0;
  const input = draft.blocks.findIndex((block) => block.type === 'currentInput');
  const selected = draft.blocks.findIndex((block) => block.id === selectedBlockId.value);
  return Math.max(1, Math.min(selected < 0 ? input : selected + 1, input));
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
        anchor: { type: 'role', position: 'afterCharacterDefinitions' },
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
        anchor: { type: 'chatHistory', depth: 0 },
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
    : insertionIndex();
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
  const [removed] = contextDraft.value.blocks.splice(index, 1);
  for (const block of contextDraft.value.blocks) {
    if (
      (block.type === 'lore' || block.type === 'authorsNote')
      && block.anchor.type === 'block'
      && block.anchor.blockId === removed.id
    ) {
      block.anchor = { type: 'role', position: 'afterCharacterDefinitions' };
    }
  }
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

function updateMovedAnchor(block: ContextPresetBlock, index: number): void {
  if (!contextDraft.value || (block.type !== 'lore' && block.type !== 'authorsNote')) return;
  const previous = contextDraft.value.blocks[index - 1];
  block.anchor = previous?.type === 'role' || previous == null
    ? { type: 'role', position: 'afterCharacterDefinitions' }
    : { type: 'block', blockId: previous.id, position: 'after' };
}

function moveBlock(blockId: string, targetStoredIndex: number): void {
  const draft = contextDraft.value;
  if (!draft || !canMoveTo(blockId, targetStoredIndex)) return;
  const from = draft.blocks.findIndex((block) => block.id === blockId);
  if (from < 0 || from === targetStoredIndex) return;
  const [block] = draft.blocks.splice(from, 1);
  draft.blocks.splice(targetStoredIndex, 0, block);
  updateMovedAnchor(block, targetStoredIndex);
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

function setAnchorType(type: Anchor['type']): void {
  const block = selectedAnchorBlock.value;
  if (!block) return;
  if (type === 'role') block.anchor = { type, position: 'afterCharacterDefinitions' };
  if (type === 'block') {
    const target = contextDraft.value?.blocks.find((item) => item.id !== block.id && item.type !== 'modelOutput');
    if (target) block.anchor = { type, blockId: target.id, position: 'after' };
  }
  if (type === 'chatHistory') block.anchor = { type, depth: 0 };
}

function anchorRole(block: LoreContextBlock | AuthorsNoteContextBlock): RoleAnchor | null {
  return block.anchor.type === 'role' ? block.anchor : null;
}

function anchorBlock(block: LoreContextBlock | AuthorsNoteContextBlock): BlockAnchor | null {
  return block.anchor.type === 'block' ? block.anchor : null;
}

function anchorHistory(block: LoreContextBlock | AuthorsNoteContextBlock): HistoryAnchor | null {
  return block.anchor.type === 'chatHistory' ? block.anchor : null;
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
  roleDraft.value?.messages.push({ role: 'system', purpose: 'description', content: '新角色说明' });
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
    <header class="workbench-toolbar">
      <h1>上下文预设</h1>
      <div class="workbench-actions">
        <el-button @click="createContext">新建</el-button>
        <el-button
          :disabled="!contextDetail || contextDetail.source !== 'runtime' || contextDetail.hasOverride"
          :loading="mutating"
          @click="removeCurrentContext"
        >
          删除
        </el-button>
        <el-button
          v-if="contextDetail?.hasOverride"
          :loading="mutating"
          @click="revertCurrentContext"
        >
          恢复 bundled
        </el-button>
        <el-button
          type="primary"
          :disabled="!contextDirty"
          :loading="savingContext"
          @click="saveContext"
        >
          保存上下文
        </el-button>
      </div>
    </header>

    <section class="preset-bar panel">
      <div class="preset-picker">
        <span class="picker-label">上下文预设</span>
        <el-select
          :model-value="selectedContextId"
          filterable
          :loading="loading"
          aria-label="选择上下文预设"
          @change="selectContext"
        >
          <el-option
            v-for="item in contextSummaries"
            :key="item.id"
            :value="item.id"
            :label="item.displayName"
          >
            <span>{{ item.displayName }}</span>
          </el-option>
        </el-select>
        <span v-if="contextDirty" class="resource-meta">未保存</span>
      </div>
      <div class="preset-actions-inline">
        <el-button
          :type="contextCatalog?.globalDefaultContextPresetId === selectedContextId ? 'success' : 'default'"
          :disabled="!selectedContextId || contextCatalog?.globalDefaultContextPresetId === selectedContextId"
          :loading="mutating"
          @click="makeDefault"
        >
          {{ contextCatalog?.globalDefaultContextPresetId === selectedContextId ? '当前全局默认' : '设为全局默认' }}
        </el-button>
      </div>
    </section>

    <div v-if="contextDraft" class="workbench-grid">
      <section class="stack-panel panel" aria-label="上下文栈">
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
            v-for="block in preview.blocks"
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
            <strong>{{ blockLabels[block.type] }}</strong>
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

      <section class="editor-panel panel">
        <div class="panel-head editor-head">
          <h2>{{ selectedBlockType ? blockLabels[selectedBlockType] : '选择一个块' }}</h2>
          <div class="block-tools">
            <el-button v-if="canDuplicateSelected" size="small" @click="duplicateSelectedBlock">
              复制
            </el-button>
            <el-button v-if="canRemoveSelected" size="small" type="danger" plain @click="removeSelectedBlock">
              移除
            </el-button>
          </div>
        </div>

        <div v-if="selectedBlockType" class="editor-body">
          <section v-if="selectedBlockGuide" class="block-guide">
            <p class="guide-summary">{{ selectedBlockGuide.summary }}</p>
            <template v-if="selectedBlockType === 'chatHistory'">
              <div class="history-example">
                <div
                  v-for="message in chatHistoryExample.messages"
                  :key="message.role"
                  class="history-message"
                >
                  <span :class="['history-role', `is-${message.role}`]">{{ message.role }}</span>
                  <code>{{ message.content }}</code>
                </div>
              </div>
            </template>
            <template v-else-if="selectedBlockType === 'requestDocuments'">
              <div class="document-wire-example">
                <strong>文本 Document 在模型请求中的实际形态</strong>
                <div class="history-message">
                  <span class="history-role">{{ requestDocumentExample.role }}</span>
                  <code>{{ requestDocumentExample.content }}</code>
                </div>
              </div>

              <div class="attachment-guide">
                <div class="attachment-guide-intro">
                  <strong>QQ群附件进入模型的方式</strong>
                  <p>附件会按类型进入当前输入、历史附件引用或回放工具。下面列出的形态是模型实际接收的内容。</p>
                </div>
                <div class="attachment-wire-examples">
                  <div
                    v-for="example in requestAttachmentExamples"
                    :key="example.label"
                    class="attachment-wire-example"
                  >
                    <strong>{{ example.label }}</strong>
                    <div class="history-message">
                      <span :class="['history-role', `is-${example.role}`]">{{ example.role }}</span>
                      <code>{{ example.content }}</code>
                    </div>
                  </div>
                </div>
                <div class="attachment-guide-list">
                  <article
                    v-for="item in requestAttachmentGuides"
                    :key="item.kind"
                    class="attachment-guide-row"
                  >
                    <strong>{{ item.label }}</strong>
                    <dl>
                      <div>
                        <dt>进入路径</dt>
                        <dd>{{ item.route }}</dd>
                      </div>
                      <div>
                        <dt>模型看到</dt>
                        <dd>{{ item.modelView }}</dd>
                      </div>
                      <div>
                        <dt>模型可用</dt>
                        <dd>{{ item.usage }}</dd>
                      </div>
                      <div>
                        <dt>能力边界</dt>
                        <dd>{{ item.boundary }}</dd>
                      </div>
                    </dl>
                  </article>
                </div>
              </div>

              <div class="document-scope-note">
                <strong>本块控制范围</strong>
                <p>“文档 Token 上限”只裁剪上面的文本 Document。当前消息里的图片或文件属于“当前输入”，历史附件引用和回放结果属于运行时注入；它们分别由自己的上下文阶段和模型能力约束。</p>
              </div>
            </template>
          </section>

          <template v-if="selectedResolvedBlock?.source === 'runtime'">
            <div class="runtime-actions">
              <span>此区块由运行时生成，没有预设配置项。</span>
              <el-button
                v-if="selectedResolvedBlock.type === 'toolDefinitions'"
                @click="router.push('/policies')"
              >
                打开工具策略
              </el-button>
            </div>
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
                  <el-form-item label="共享角色">
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
                  <el-form-item label="角色显示名">
                    <el-input v-model="roleDraft.displayName" />
                  </el-form-item>
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
                      <el-select v-model="message.purpose" clearable size="small" placeholder="purpose">
                        <el-option label="description" value="description" />
                        <el-option label="personality" value="personality" />
                        <el-option label="scenario" value="scenario" />
                        <el-option label="firstMessage" value="firstMessage" />
                        <el-option label="exampleStart" value="exampleStart" />
                        <el-option label="exampleEnd" value="exampleEnd" />
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
                    <el-button type="primary" :disabled="!roleDirty" :loading="savingRole" @click="saveRole">
                      保存共享角色
                    </el-button>
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

              <template v-if="selectedAnchorBlock">
                <div class="anchor-editor">
                  <strong>注入锚点</strong>
                  <div class="form-grid two">
                    <el-form-item label="Anchor 类型">
                      <el-select :model-value="selectedAnchorBlock.anchor.type" @change="setAnchorType">
                        <el-option label="角色结构" value="role" />
                        <el-option label="其他块" value="block" />
                        <el-option label="聊天历史深度" value="chatHistory" />
                      </el-select>
                    </el-form-item>
                    <el-form-item v-if="anchorRole(selectedAnchorBlock)" label="角色位置">
                      <el-select v-model="anchorRole(selectedAnchorBlock)!.position">
                        <el-option
                          v-for="position in rolePositions"
                          :key="position.value"
                          :value="position.value"
                          :label="position.label"
                        />
                      </el-select>
                    </el-form-item>
                    <el-form-item v-if="anchorBlock(selectedAnchorBlock)" label="目标块">
                      <el-select v-model="anchorBlock(selectedAnchorBlock)!.blockId">
                        <el-option
                          v-for="block in anchorTargetBlocks"
                          :key="block.id"
                          :value="block.id"
                          :label="`${blockLabels[block.type]} · ${block.id}`"
                        />
                      </el-select>
                    </el-form-item>
                    <el-form-item v-if="anchorBlock(selectedAnchorBlock)" label="相对位置">
                      <el-select v-model="anchorBlock(selectedAnchorBlock)!.position">
                        <el-option label="之前" value="before" />
                        <el-option label="之后" value="after" />
                      </el-select>
                    </el-form-item>
                    <el-form-item v-if="anchorHistory(selectedAnchorBlock)" label="历史深度">
                      <el-input-number v-model="anchorHistory(selectedAnchorBlock)!.depth" :min="0" />
                    </el-form-item>
                  </div>
                </div>
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
        </div>
        <div v-else class="editor-empty">从左侧选择一个上下文块。</div>
      </section>
    </div>

    <div v-else-if="!loading" class="panel empty-workbench">
      当前没有可编辑的上下文预设。
    </div>
  </div>
</template>

<style scoped>
.context-workbench {
  min-width: 0;
  --workbench-height: clamp(560px, calc(100vh - 238px), 760px);
}

.workbench-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 2px 0 14px;
}

.workbench-toolbar h1 {
  margin: 0;
  color: #182033;
  font-size: 28px;
  line-height: 1.15;
  letter-spacing: -.04em;
}

.workbench-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.preset-bar {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 16px;
  padding: 13px 16px;
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
  width: min(420px, 48vw);
}

.picker-label {
  flex: none;
  color: #657083;
  font-size: 11px;
  font-weight: 700;
}

.resource-meta {
  color: #8a93a2;
  font-size: 11px;
}

.workbench-grid {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  align-items: stretch;
  gap: 14px;
  min-width: 0;
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
  background: #f8f9fc;
}

.editor-panel {
  display: flex;
  flex-direction: column;
}

.editor-head {
  flex: none;
  min-height: 64px;
}

.editor-head h2 {
  margin-bottom: 3px;
}

.context-stack {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px;
  overflow: auto;
}

.stack-block {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 44px;
  padding: 0 13px;
  border: 1px solid rgba(206, 216, 232, .92);
  border-radius: 9px;
  color: #263248;
  background: #fff;
  cursor: pointer;
  outline: none;
  transition: background .14s ease, border-color .14s ease, box-shadow .14s ease;
}

.stack-block:hover,
.stack-block:focus-visible {
  border-color: #9fb1df;
  background: #fafbff;
}

.stack-block.selected {
  border-color: #5c7fe2;
  color: #244ba9;
  background: #eef3ff;
  box-shadow: inset 3px 0 0 #5c7fe2;
}

.stack-block.disabled {
  color: #7c8798;
  background: #f4f5f7;
  opacity: .72;
}

.stack-block.runtime {
  border-style: dashed;
  background: rgba(248, 250, 253, .9);
}

.stack-block.dragging {
  opacity: .55;
}

.stack-block strong {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add-block-tray {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: none;
  padding: 12px 16px 14px;
  border-top: 1px solid rgba(219, 226, 238, .9);
  background: rgba(255, 255, 255, .78);
  backdrop-filter: blur(10px);
}

.add-block-tray button {
  height: 28px;
  padding: 0 10px;
  border: 1px solid #dbe4f2;
  border-radius: 999px;
  color: #40506a;
  background: #fff;
  font-size: 11px;
  cursor: pointer;
}

.add-block-tray button:hover {
  border-color: #9db3ef;
  color: #315fc8;
  background: #f5f8ff;
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
  padding: 20px;
  overflow: auto;
}

.block-guide {
  margin-bottom: 20px;
  padding: 0 0 18px;
  border-bottom: 1px solid #e5e9f0;
}

.guide-summary {
  max-width: 760px;
  margin: 0;
  color: #29354a;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.7;
}

.history-example {
  max-width: 800px;
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid #dce3ee;
  border-radius: 9px;
  background: #f8fafc;
}

.history-message {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 10px 12px;
}

.history-message + .history-message {
  border-top: 1px solid #e4e9f1;
}

.history-role {
  width: fit-content;
  padding: 2px 7px;
  border-radius: 999px;
  color: #3159a7;
  background: #e9f0ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  font-weight: 700;
}

.history-role.is-assistant {
  color: #397357;
  background: #e7f5ed;
}

.history-message code {
  min-width: 0;
  color: #253148;
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.document-wire-example {
  max-width: 800px;
  margin-top: 18px;
  overflow: hidden;
  border: 1px solid #dce3ee;
  border-radius: 9px;
  background: #f8fafc;
}

.document-wire-example > strong {
  display: block;
  padding: 11px 12px;
  border-bottom: 1px solid #e4e9f1;
  color: #263248;
  font-size: 12px;
}

.attachment-guide {
  max-width: 800px;
  margin-top: 22px;
}

.attachment-guide-intro {
  margin-bottom: 8px;
}

.attachment-guide-intro strong,
.document-scope-note strong {
  color: #263248;
  font-size: 13px;
}

.attachment-guide-intro p,
.document-scope-note p {
  margin: 5px 0 0;
  color: #59657a;
  font-size: 12px;
  line-height: 1.7;
}

.attachment-wire-examples {
  display: grid;
  gap: 10px;
  margin: 14px 0 20px;
}

.attachment-wire-example {
  overflow: hidden;
  border: 1px solid #dce3ee;
  border-radius: 9px;
  background: #f8fafc;
}

.attachment-wire-example > strong {
  display: block;
  padding: 9px 12px;
  border-bottom: 1px solid #e4e9f1;
  color: #344158;
  font-size: 12px;
}

.history-role.is-system {
  color: #7650a4;
  background: #f0e9f8;
}

.attachment-guide-list {
  border-top: 1px solid #dfe5ee;
}

.attachment-guide-row {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 18px;
  padding: 15px 0;
  border-bottom: 1px solid #e4e9f1;
}

.attachment-guide-row > strong {
  color: #24324a;
  font-size: 12px;
}

.attachment-guide-row dl {
  min-width: 0;
  display: grid;
  gap: 7px;
  margin: 0;
}

.attachment-guide-row dl > div {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: 10px;
}

.attachment-guide-row dt {
  color: #68758a;
  font-size: 12px;
  font-weight: 650;
}

.attachment-guide-row dd {
  min-width: 0;
  margin: 0;
  color: #344158;
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.document-scope-note {
  max-width: 800px;
  margin-top: 18px;
  padding-left: 12px;
  border-left: 3px solid #9db2e9;
}

.runtime-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: #6f7a8d;
  font-size: 11px;
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
  grid-template-columns: 90px minmax(260px, 1fr);
  gap: 0 14px;
  align-items: start;
  margin-bottom: 8px;
}

.budget-settings .el-form-item {
  margin-bottom: 10px;
}

.budget-settings .wide {
  grid-column: 1 / -1;
}

.token-limit-control {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.token-limit-control .el-segmented {
  max-width: 100%;
}

.custom-token-limit {
  width: 160px;
}

.form-grid {
  display: grid;
  gap: 14px;
}

.form-grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
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
  min-width: min(100%, 360px);
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
.lore-entry,
.anchor-editor {
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

.anchor-editor > strong {
  display: block;
  margin-bottom: 13px;
  font-size: 12px;
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
    grid-template-columns: 204px minmax(0, 1fr);
  }
}

@media (max-width: 820px) {
  .context-workbench {
    --workbench-height: auto;
  }

  .workbench-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .workbench-actions {
    width: 100%;
    justify-content: flex-start;
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
  .role-actions,
  .workbench-actions {
    width: 100%;
    align-items: stretch;
    flex-direction: column;
  }

  .budget-settings {
    grid-template-columns: 1fr;
  }

  .history-message {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .attachment-guide-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .attachment-guide-row dl > div {
    grid-template-columns: 62px minmax(0, 1fr);
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
