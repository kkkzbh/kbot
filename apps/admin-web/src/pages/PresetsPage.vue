<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  contextBlueprintResponseSchema,
  contextSnapshotResponseSchema,
  contextTargetsResponseSchema,
  emptyResponseSchema,
  presetCatalogResponseSchema,
  presetCreateRequestSchema,
  presetDefaultRequestSchema,
  presetDefaultResponseSchema,
  presetDefinitionV2Schema,
  presetDetailResponseSchema,
  presetRevisionRequestSchema,
  presetUpdateRequestSchema,
  type ContextBlueprintResponse,
  type ContextSnapshot,
  type ContextTarget,
  type PresetCatalogResponse,
  type PresetDefinitionV2,
  type PresetDetailResponse,
  type PresetResolution,
} from '@contracts';
import type { ZodIssue } from 'zod';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import { ApiError, api, jsonBody } from '@/api/client';

type PresetMessage = PresetDefinitionV2['messages'][number];
type MessageRole = PresetMessage['role'];
type MessagePurpose = NonNullable<PresetMessage['purpose']>;
type PresetContentBlock = Extract<PresetMessage['content'], unknown[]>[number];
type ContentBlockType = 'text' | 'image' | 'file' | 'audio' | 'video';
type ContentKind = 'message' | 'lore' | 'authorsNote' | 'knowledge';
type LoreDefaults = PresetDefinitionV2['lore']['defaults'];
type LoreInsertPosition = NonNullable<LoreDefaults['insertPosition']>;
type PromptConfig = PresetDefinitionV2['promptConfig'];
type OptionalPromptKey = Exclude<{
  [Key in keyof PromptConfig]: PromptConfig[Key] extends string | undefined ? Key : never;
}[keyof PromptConfig], undefined>;
type MutationKind = 'save' | 'default' | 'delete' | 'revert';

interface FieldIssue {
  path: string;
  message: string;
  anchor: string;
}

const NEW_PRESET_KEY = '__new_preset__';
const messageRoles: Array<{ value: MessageRole; label: string; help: string }> = [
  { value: 'system', label: '系统规则', help: '规则、边界和长期约束' },
  { value: 'user', label: '用户示例', help: '示例用户消息或静态用户上下文' },
  { value: 'assistant', label: '助手示例', help: '示例回复或开场消息' },
];
const purposes: Array<{ value: MessagePurpose; label: string }> = [
  { value: 'description', label: '角色描述' },
  { value: 'personality', label: '性格' },
  { value: 'scenario', label: '场景' },
  { value: 'firstMessage', label: '开场消息' },
  { value: 'exampleStart', label: '示例对话起点' },
  { value: 'exampleEnd', label: '示例对话终点' },
];
const lorePositions: Array<{ value: LoreInsertPosition; label: string }> = [
  { value: 'beforeCharacterDefinitions', label: '角色定义前' },
  { value: 'afterCharacterDefinitions', label: '角色定义后' },
  { value: 'beforeScenario', label: '场景前' },
  { value: 'afterScenario', label: '场景后' },
  { value: 'beforeExampleMessages', label: '示例对话前' },
  { value: 'afterExampleMessages', label: '示例对话后' },
];
const resolutionSourceLabels: Record<PresetResolution['source'], string> = {
  fixed: '固定预设',
  conversation: '会话预设',
  presetLane: 'Binding preset lane',
  constraintDefault: '约束默认',
  globalDefault: '全局默认',
};

const catalog = ref<PresetCatalogResponse | null>(null);
const selectedKey = ref('');
const drafts = reactive<Record<string, PresetDefinitionV2>>({});
const baselines = reactive<Record<string, string>>({});
const detailMeta = reactive<Record<string, Omit<PresetDetailResponse, 'preset'>>>({});
const loading = ref(false);
const targetsLoading = ref(false);
const contextLoading = ref(false);
const contextTargets = ref<ContextTarget[]>([]);
const catalogError = ref('');
const targetsError = ref('');
const selectedConversationId = ref('');
const blueprint = shallowRef<ContextBlueprintResponse | null>(null);
const blueprintError = ref('');
const snapshot = shallowRef<ContextSnapshot | null>(null);
const snapshotUnavailable = ref('');
const mutationBusy = ref<MutationKind | null>(null);
const router = useRouter();
let detailRequestEpoch = 0;
let blueprintRequestEpoch = 0;
let snapshotRequestEpoch = 0;
let targetsRequestEpoch = 0;

const current = computed(() => drafts[selectedKey.value] ?? null);
const currentMeta = computed(() => detailMeta[selectedKey.value] ?? null);
const isNew = computed(() => selectedKey.value === NEW_PRESET_KEY);
const currentBaseline = computed(() => baselines[selectedKey.value] ?? '');
const currentDirty = computed(() => current.value != null && JSON.stringify(current.value) !== currentBaseline.value);
const currentValidation = computed(() =>
  current.value ? presetDefinitionV2Schema.safeParse(current.value) : null,
);
const currentValid = computed(() => currentValidation.value?.success === true);
const fieldIssues = computed<FieldIssue[]>(() => {
  const validation = currentValidation.value;
  if (!validation || validation.success || !currentDirty.value) return [];
  return validation.error.issues.map(formatFieldIssue);
});
const canSave = computed(() =>
  current.value != null
  && currentDirty.value
  && currentValid.value
  && mutationBusy.value === null
  && (isNew.value || Boolean(currentMeta.value?.revision)),
);
const saving = computed(() => mutationBusy.value === 'save');
const hasDirtyDrafts = computed(() =>
  Object.entries(drafts).some(([key, value]) => JSON.stringify(value) !== (baselines[key] ?? '')),
);
const selectedTarget = computed(() =>
  contextTargets.value.find((target) => target.conversationId === selectedConversationId.value) ?? null,
);
const selectedConversationPresetId = computed(() =>
  snapshot.value?.conversationId === selectedConversationId.value
    ? snapshot.value.effectivePresetId ?? null
    : null,
);
const isSelectedConversationPreset = computed(() =>
  current.value != null && selectedConversationPresetId.value === current.value.id,
);
const sortedBlueprintSections = computed(() =>
  [...(blueprint.value?.sections ?? [])].sort((left, right) => left.order - right.order),
);
const includedMessages = computed(() => snapshot.value?.messages.filter((message) => message.included) ?? []);
const droppedMessages = computed(() => snapshot.value?.messages.filter((message) => !message.included) ?? []);

function clonePreset(value: PresetDefinitionV2): PresetDefinitionV2 {
  return structuredClone(value);
}

function createEmptyPreset(): PresetDefinitionV2 {
  return {
    schemaVersion: 2,
    id: '',
    displayName: '',
    aliases: [],
    messages: [],
    inputFormat: null,
    lore: { defaults: {}, entries: [] },
    authorsNote: null,
    knowledge: null,
    promptConfig: {},
  };
}

function serialize(value: PresetDefinitionV2): string {
  return JSON.stringify(value);
}

function isDraftDirty(id: string): boolean {
  const draft = drafts[id];
  return draft != null && serialize(draft) !== (baselines[id] ?? '');
}

function roleHelp(role: MessageRole): string {
  return messageRoles.find((item) => item.value === role)?.help ?? '';
}

function formatContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content, null, 2);
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未上报';
  return `${(value * 100).toFixed(value < 0.1 ? 2 : 1)}%`;
}

function formatProviderUsage(snapshotValue: ContextSnapshot): string {
  const input = snapshotValue.providerInputTokens;
  const output = snapshotValue.providerOutputTokens;
  if (input == null && output == null) return '等待 provider 回报';
  const suffix = snapshotValue.providerUsageEstimated ? '（估算）' : '';
  return `${input ?? '—'} input / ${output ?? '—'} output${suffix}`;
}

function resolutionSourceLabel(source: PresetResolution['source']): string {
  return resolutionSourceLabels[source];
}

function anchorForIssue(path: PropertyKey[]): string {
  const root = String(path[0] ?? '');
  if (root === 'messages') return 'preset-messages';
  if (root === 'inputFormat') return 'preset-input-format';
  if (root === 'lore') return 'preset-lore';
  if (root === 'authorsNote') return 'preset-authors-note';
  if (root === 'knowledge') return 'preset-knowledge';
  if (root === 'promptConfig') return 'preset-prompt-config';
  return 'preset-basics';
}

function formatFieldIssue(issue: ZodIssue): FieldIssue {
  return {
    path: issue.path.length ? issue.path.map(String).join('.') : 'preset',
    message: issue.message,
    anchor: anchorForIssue(issue.path),
  };
}

function revealIssue(issue: FieldIssue): void {
  focusEditorSection(issue.anchor);
}

function optionalString(value: string | undefined): string {
  return value ?? '';
}

function assignOptionalString<Target extends object, Key extends keyof Target>(
  target: Target,
  key: Key,
  value: string,
): void {
  if (value.length === 0) {
    delete target[key];
    return;
  }
  target[key] = value as Target[Key];
}

function assignOptionalNumber<Target extends object, Key extends keyof Target>(
  target: Target,
  key: Key,
  value: number | null | undefined,
): void {
  if (value == null) {
    delete target[key];
    return;
  }
  target[key] = value as Target[Key];
}

function setPromptText(key: OptionalPromptKey, value: string): void {
  if (!current.value) return;
  assignOptionalString(current.value.promptConfig, key, value);
}

function isDialogCancel(error: unknown): boolean {
  return error === 'cancel' || error === 'close';
}

function mutationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object') {
    return error.message;
  }
  const details = error.details as Record<string, unknown>;
  const context = [
    typeof details.operation === 'string' ? `operation=${details.operation}` : '',
    typeof details.stage === 'string' ? `stage=${details.stage}` : '',
    typeof details.presetId === 'string' ? `preset=${details.presetId}` : '',
  ].filter(Boolean);
  return context.length ? `${error.message}（${context.join('，')}）` : error.message;
}

async function runMutation(
  kind: MutationKind,
  fallback: string,
  operation: () => Promise<void>,
): Promise<void> {
  if (mutationBusy.value !== null) {
    ElMessage.info('已有预设操作正在执行');
    return;
  }
  mutationBusy.value = kind;
  try {
    await operation();
  } catch (error) {
    if (!isDialogCancel(error)) ElMessage.error(mutationErrorMessage(error, fallback));
  } finally {
    mutationBusy.value = null;
  }
}

function shouldCollapseMessage(message: ContextSnapshot['messages'][number]): boolean {
  const search = `${message.stage} ${message.source} ${message.sourcePath ?? ''}`.toLocaleLowerCase();
  return /(history|memory|long.?memory|knowledge|document|current.?input|user.?input)/.test(search);
}

function moveItem<T>(items: T[], index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= items.length) return;
  const [item] = items.splice(index, 1);
  items.splice(target, 0, item);
}

function addMessage(kind: MessagePurpose | 'plain'): void {
  if (!current.value) return;
  const templates: Record<MessagePurpose | 'plain', PresetMessage> = {
    plain: { role: 'system', content: '' },
    description: { role: 'system', purpose: 'description', content: '' },
    personality: { role: 'system', purpose: 'personality', content: '' },
    scenario: { role: 'system', purpose: 'scenario', content: '' },
    firstMessage: { role: 'assistant', purpose: 'firstMessage', content: '' },
    exampleStart: { role: 'user', purpose: 'exampleStart', content: '' },
    exampleEnd: { role: 'assistant', purpose: 'exampleEnd', content: '' },
  };
  current.value.messages.push(structuredClone(templates[kind]));
}

function focusEditorSection(id: string): void {
  requestAnimationFrame(() => {
    const section = document.getElementById(id);
    if (section instanceof HTMLDetailsElement) section.open = true;
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function addContent(kind: ContentKind): void {
  if (!current.value) return;
  if (kind === 'message') {
    addMessage('plain');
    focusEditorSection('preset-messages');
    return;
  }
  if (kind === 'lore') {
    current.value.lore.entries.push({ keywords: [], content: '', enabled: true });
    focusEditorSection('preset-lore');
    return;
  }
  if (kind === 'authorsNote') {
    if (current.value.authorsNote === null) setAuthorsNote(true);
    focusEditorSection('preset-authors-note');
    return;
  }
  if (current.value.knowledge === null) setKnowledge(true);
  focusEditorSection('preset-knowledge');
}

function setContentMode(message: PresetMessage, mode: 'text' | 'blocks'): void {
  if (mode === 'blocks' && typeof message.content === 'string') {
    message.content = [{ type: 'text', text: message.content }];
  } else if (mode === 'text' && Array.isArray(message.content)) {
    if (message.content.some((block) => block.type !== 'text')) {
      ElMessage.warning('结构化消息包含媒体块；请先明确移除媒体块，再切换为纯文本');
      return;
    }
    message.content = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
  }
}

function addContentBlock(message: PresetMessage): void {
  if (!Array.isArray(message.content)) setContentMode(message, 'blocks');
  if (Array.isArray(message.content)) message.content.push({ type: 'text', text: '' });
}

function createContentBlock(type: ContentBlockType): PresetContentBlock {
  return type === 'text' ? { type, text: '' } : { type, url: '' };
}

function changeContentBlockType(message: PresetMessage, index: number, type: ContentBlockType): void {
  if (!Array.isArray(message.content)) return;
  message.content[index] = createContentBlock(type);
}

function setAuthorsNote(enabled: unknown): void {
  if (!current.value) return;
  current.value.authorsNote = enabled
    ? { content: '', insertPosition: 'inChat', insertDepth: 0, insertFrequency: 1 }
    : null;
}

function setKnowledge(enabled: unknown): void {
  if (!current.value) return;
  current.value.knowledge = enabled ? { sources: [] } : null;
}

function setPostHandler(enabled: unknown): void {
  if (!current.value) return;
  current.value.promptConfig.postHandler = enabled
    ? { id: '', prefix: '', postfix: '', variables: {} }
    : undefined;
}

function addPostVariable(): void {
  const variables = current.value?.promptConfig.postHandler?.variables;
  if (!variables) return;
  let index = Object.keys(variables).length + 1;
  while (`variable${index}` in variables) index += 1;
  variables[`variable${index}`] = '';
}

function renamePostVariable(oldKey: string, nextKey: string): void {
  const variables = current.value?.promptConfig.postHandler?.variables;
  const normalized = nextKey.trim();
  if (!variables || !normalized || normalized === oldKey) return;
  if (normalized in variables) {
    ElMessage.error(`变量 ${normalized} 已存在`);
    return;
  }
  variables[normalized] = variables[oldKey];
  delete variables[oldKey];
}

async function refreshCatalog(): Promise<PresetCatalogResponse> {
  const result = await api('/presets', presetCatalogResponseSchema);
  catalog.value = result;
  return result;
}

async function loadBlueprint(presetId: string): Promise<void> {
  const epoch = ++blueprintRequestEpoch;
  blueprint.value = null;
  blueprintError.value = '';
  try {
    const result = await api(
      `/model-context/blueprint?presetId=${encodeURIComponent(presetId)}`,
      contextBlueprintResponseSchema,
    );
    if (epoch !== blueprintRequestEpoch || selectedKey.value !== presetId) return;
    blueprint.value = result;
  } catch (error) {
    if (epoch !== blueprintRequestEpoch || selectedKey.value !== presetId) return;
    blueprintError.value = mutationErrorMessage(error, '上下文结构加载失败');
  }
}

function hydrateDetail(detail: PresetDetailResponse): void {
  drafts[detail.preset.id] = clonePreset(detail.preset);
  baselines[detail.preset.id] = serialize(detail.preset);
  detailMeta[detail.preset.id] = {
    source: detail.source,
    hasOverride: detail.hasOverride,
    revision: detail.revision,
  };
}

function sortPresetCatalog(items: PresetCatalogResponse['presets']): PresetCatalogResponse['presets'] {
  return [...items].sort((left, right) => {
    const displayOrder = left.displayName.localeCompare(right.displayName, 'zh-CN');
    return displayOrder || left.id.localeCompare(right.id);
  });
}

function updateCatalogDetail(detail: PresetDetailResponse): void {
  if (!catalog.value) return;
  const summary = {
    id: detail.preset.id,
    displayName: detail.preset.displayName,
    aliases: detail.preset.aliases,
    source: detail.source,
    hasOverride: detail.hasOverride,
    revision: detail.revision,
    isGlobalDefault: catalog.value.globalDefaultPresetId === detail.preset.id,
  };
  catalog.value = {
    ...catalog.value,
    presets: sortPresetCatalog([
      ...catalog.value.presets.filter((item) => item.id !== summary.id),
      summary,
    ]),
  };
}

function updateCatalogDefault(globalDefaultPresetId: string): void {
  if (!catalog.value) return;
  catalog.value = {
    globalDefaultPresetId,
    presets: catalog.value.presets.map((item) => ({
      ...item,
      isGlobalDefault: item.id === globalDefaultPresetId,
    })),
  };
}

function removeCatalogPreset(id: string): void {
  if (!catalog.value) return;
  catalog.value = {
    ...catalog.value,
    presets: catalog.value.presets.filter((item) => item.id !== id),
  };
}

async function openPreset(id: string, options: { force?: boolean } = {}): Promise<void> {
  selectedKey.value = id;
  if (id === NEW_PRESET_KEY) {
    ++detailRequestEpoch;
    ++blueprintRequestEpoch;
    loading.value = false;
    blueprint.value = null;
    blueprintError.value = '';
    return;
  }
  const epoch = ++detailRequestEpoch;
  const blueprintPromise = loadBlueprint(id);
  if (drafts[id] && !options.force) {
    loading.value = false;
    return blueprintPromise;
  }
  loading.value = true;
  try {
    const detail = await api(`/presets/${encodeURIComponent(id)}`, presetDetailResponseSchema);
    if (epoch !== detailRequestEpoch || selectedKey.value !== id) return;
    hydrateDetail(detail);
    updateCatalogDetail(detail);
    await blueprintPromise;
  } catch (error) {
    if (epoch !== detailRequestEpoch || selectedKey.value !== id) return;
    ElMessage.error(mutationErrorMessage(error, '预设详情加载失败'));
  } finally {
    if (epoch === detailRequestEpoch) loading.value = false;
  }
}

async function loadTargets(): Promise<void> {
  const epoch = ++targetsRequestEpoch;
  targetsLoading.value = true;
  targetsError.value = '';
  try {
    const result = await api('/model-context/targets', contextTargetsResponseSchema);
    if (epoch !== targetsRequestEpoch) return;
    contextTargets.value = result.targets;
  } catch (error) {
    if (epoch !== targetsRequestEpoch) return;
    targetsError.value = mutationErrorMessage(error, '会话列表加载失败');
  } finally {
    if (epoch === targetsRequestEpoch) targetsLoading.value = false;
  }
}

function assertGlobalDefault(result: PresetCatalogResponse): string {
  const id = result.globalDefaultPresetId;
  if (!result.presets.some((preset) => preset.id === id)) {
    throw new Error(`全局默认预设 ${id} 没有对应的已加载定义`);
  }
  return id;
}

async function loadInitial(): Promise<void> {
  loading.value = true;
  catalogError.value = '';
  void loadTargets();
  try {
    const nextCatalog = await refreshCatalog();
    await openPreset(assertGlobalDefault(nextCatalog));
  } catch (error) {
    catalogError.value = mutationErrorMessage(error, '预设目录加载失败');
    ElMessage.error(catalogError.value);
  } finally {
    loading.value = false;
  }
}

async function reload(): Promise<void> {
  if (currentDirty.value) {
    try {
      await ElMessageBox.confirm(
        '重新载入会丢弃当前预设的未保存修改。',
        '放弃当前草稿？',
        { type: 'warning', confirmButtonText: '放弃并载入', cancelButtonText: '继续编辑' },
      );
    } catch {
      return;
    }
  }
  loading.value = true;
  catalogError.value = '';
  void loadTargets();
  try {
    const nextCatalog = await refreshCatalog();
    const defaultId = assertGlobalDefault(nextCatalog);
    const requestedId = !isNew.value && nextCatalog.presets.some((item) => item.id === selectedKey.value)
      ? selectedKey.value
      : defaultId;
    await openPreset(requestedId, { force: true });
  } catch (error) {
    catalogError.value = mutationErrorMessage(error, '预设目录重新载入失败');
    ElMessage.error(catalogError.value);
  } finally {
    loading.value = false;
  }
}

function createPreset(): void {
  if (!drafts[NEW_PRESET_KEY]) {
    drafts[NEW_PRESET_KEY] = createEmptyPreset();
    baselines[NEW_PRESET_KEY] = serialize(drafts[NEW_PRESET_KEY]);
    detailMeta[NEW_PRESET_KEY] = {
      source: 'runtime',
      hasOverride: false,
      revision: '',
    };
  }
  selectedKey.value = NEW_PRESET_KEY;
  ++detailRequestEpoch;
  ++blueprintRequestEpoch;
  blueprint.value = null;
  blueprintError.value = '';
}

function validateCurrent(): PresetDefinitionV2 {
  if (!current.value) throw new Error('没有可保存的预设');
  const result = presetDefinitionV2Schema.safeParse(clonePreset(current.value));
  if (!result.success) {
    const first = formatFieldIssue(result.error.issues[0]);
    revealIssue(first);
    throw new Error(`${first.path}: ${first.message}`);
  }
  return result.data;
}

async function save(): Promise<void> {
  if (!canSave.value) {
    if (fieldIssues.value[0]) revealIssue(fieldIssues.value[0]);
    return;
  }
  await runMutation('save', '预设保存失败', async () => {
    const payload = validateCurrent();
    const detail = isNew.value
      ? await api('/presets', presetDetailResponseSchema, {
          method: 'POST',
          body: jsonBody(presetCreateRequestSchema, { preset: payload }),
        })
      : await api(`/presets/${encodeURIComponent(payload.id)}`, presetDetailResponseSchema, {
          method: 'PUT',
          body: jsonBody(presetUpdateRequestSchema, {
            preset: payload,
            expectedRevision: currentMeta.value?.revision,
          }),
        });
    const previousKey = selectedKey.value;
    if (previousKey !== detail.preset.id) {
      delete drafts[previousKey];
      delete baselines[previousKey];
      delete detailMeta[previousKey];
    }
    hydrateDetail(detail);
    updateCatalogDetail(detail);
    selectedKey.value = detail.preset.id;
    await loadBlueprint(detail.preset.id);
    ElMessage.success('预设已保存并加载到运行时');
  });
}

async function setGlobalDefault(): Promise<void> {
  if (!current.value || isNew.value || currentDirty.value) {
    ElMessage.warning('请先保存当前预设');
    return;
  }
  const id = current.value.id;
  await runMutation('default', '设置全局默认预设失败', async () => {
    const result = await api('/presets/default', presetDefaultResponseSchema, {
      method: 'PUT',
      body: jsonBody(presetDefaultRequestSchema, { id }),
    });
    updateCatalogDefault(result.globalDefaultPresetId);
    ElMessage.success('全局默认预设已立即更新');
  });
}

async function removeRuntimePreset(): Promise<void> {
  if (!current.value) return;
  if (catalog.value?.globalDefaultPresetId === current.value.id) {
    ElMessage.error('全局默认预设无法删除，请先将其他预设设为全局默认');
    return;
  }
  const { id, displayName } = current.value;
  const revision = currentMeta.value?.revision;
  if (!revision) {
    ElMessage.error('当前预设缺少 loaded revision，请重新加载后再删除');
    return;
  }
  const draftWarning = currentDirty.value ? '当前未保存草稿也会被丢弃。' : '';
  await runMutation('delete', '删除运行时预设失败', async () => {
    await ElMessageBox.confirm(
      `永久删除运行时预设 ${displayName}？${draftWarning}`,
      '确认删除',
      { type: 'warning' },
    );
    await api(`/presets/${encodeURIComponent(id)}`, emptyResponseSchema, {
      method: 'DELETE',
      body: jsonBody(presetRevisionRequestSchema, { expectedRevision: revision }),
    });
    delete drafts[id];
    delete baselines[id];
    delete detailMeta[id];
    removeCatalogPreset(id);
    const next = catalog.value;
    if (!next) throw new Error('预设目录在删除后不可用');
    await openPreset(assertGlobalDefault(next));
    ElMessage.success('运行时预设已删除');
  });
}

async function revertOverride(): Promise<void> {
  if (!current.value) return;
  const { id, displayName } = current.value;
  const revision = currentMeta.value?.revision;
  if (!revision) {
    ElMessage.error('当前预设缺少 loaded revision，请重新加载后再撤销覆盖');
    return;
  }
  const draftWarning = currentDirty.value ? '当前未保存草稿也会被丢弃。' : '';
  await runMutation('revert', '撤销运行时覆盖失败', async () => {
    await ElMessageBox.confirm(
      `撤销 ${displayName} 的运行时覆盖？${draftWarning}`,
      '撤销覆盖',
      { type: 'warning' },
    );
    const detail = await api(
      `/presets/${encodeURIComponent(id)}/override`,
      presetDetailResponseSchema,
      {
        method: 'DELETE',
        body: jsonBody(presetRevisionRequestSchema, {
          expectedRevision: revision,
        }),
      },
    );
    hydrateDetail(detail);
    updateCatalogDetail(detail);
    await loadBlueprint(detail.preset.id);
    ElMessage.success('运行时覆盖已撤销');
  });
}

async function loadSnapshot(): Promise<void> {
  const conversationId = selectedConversationId.value;
  if (!conversationId) return;
  const epoch = ++snapshotRequestEpoch;
  contextLoading.value = true;
  snapshotUnavailable.value = '';
  try {
    const result = await api(
      `/model-context/snapshots/${encodeURIComponent(conversationId)}`,
      contextSnapshotResponseSchema,
    );
    if (epoch !== snapshotRequestEpoch || selectedConversationId.value !== conversationId) return;
    snapshot.value = result.snapshot;
    snapshotUnavailable.value = result.unavailableReason ?? '';
  } catch (error) {
    if (epoch !== snapshotRequestEpoch || selectedConversationId.value !== conversationId) return;
    snapshot.value = null;
    snapshotUnavailable.value = mutationErrorMessage(error, '上下文实况加载失败');
  } finally {
    if (epoch === snapshotRequestEpoch) contextLoading.value = false;
  }
}

function changeConversation(value: string): void {
  ++snapshotRequestEpoch;
  snapshot.value = null;
  snapshotUnavailable.value = '';
  contextLoading.value = false;
  if (value) void loadSnapshot();
}

async function editEffectivePreset(): Promise<void> {
  const presetId = snapshot.value?.conversationId === selectedConversationId.value
    ? snapshot.value.effectivePresetId
    : null;
  if (!presetId) return;
  await openPreset(presetId);
  await router.replace({ path: '/intelligence/presets', hash: '#context-inspector' });
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!hasDirtyDrafts.value) return;
  event.preventDefault();
}

function handleSave(): void {
  void save();
}

onBeforeRouteLeave(async () => {
  if (!hasDirtyDrafts.value) return true;
  try {
    await ElMessageBox.confirm('存在未保存的预设草稿，确定离开页面？', '未保存的更改', {
      type: 'warning',
      confirmButtonText: '离开',
      cancelButtonText: '继续编辑',
    });
    return true;
  } catch {
    return false;
  }
});

onMounted(() => {
  void loadInitial();
  window.addEventListener('admin-save', handleSave);
  window.addEventListener('beforeunload', beforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener('admin-save', handleSave);
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <PageHeader
    :saving="saving"
    :save-disabled="!canSave"
    save-label="保存当前预设"
    @save="save"
  >
    <template #actions>
      <el-button :loading="loading" :disabled="mutationBusy !== null" @click="reload">重新载入</el-button>
      <el-button :disabled="mutationBusy !== null" @click="createPreset">新建预设</el-button>
    </template>
  </PageHeader>

  <article class="panel preset-workspace" v-loading="loading && !catalog">
    <p v-if="catalogError" class="context-error top-error" role="alert">{{ catalogError }}</p>
    <div class="preset-toolbar">
      <div class="preset-picker">
        <label>当前编辑预设</label>
        <el-select
          v-model="selectedKey"
          filterable
          aria-label="选择要编辑的角色预设"
          :disabled="mutationBusy !== null"
          placeholder="选择预设"
          @change="(value: string) => openPreset(value)"
        >
          <el-option
            v-if="drafts[NEW_PRESET_KEY]"
            :value="NEW_PRESET_KEY"
            label="新建预设（未保存）"
          />
          <el-option
            v-for="item in catalog?.presets ?? []"
            :key="item.id"
            :value="item.id"
            :label="`${item.displayName} · ${item.id}`"
          >
            <div class="preset-option">
              <span>{{ item.displayName }}</span>
              <small>{{ item.id }}</small>
              <el-tag v-if="item.isGlobalDefault" size="small">全局默认</el-tag>
              <el-tag v-if="isDraftDirty(item.id)" size="small" type="danger">草稿</el-tag>
            </div>
          </el-option>
        </el-select>
      </div>
      <div v-if="current" class="preset-status">
        <el-tag v-if="catalog?.globalDefaultPresetId === current.id" type="success">全局默认</el-tag>
        <el-tag v-if="isSelectedConversationPreset" type="success">当前会话生效</el-tag>
        <el-tag :type="currentMeta?.source === 'runtime' ? 'primary' : 'info'">
          {{ currentMeta?.source === 'runtime' ? '运行时' : '内置' }}
        </el-tag>
        <el-tag v-if="currentMeta?.hasOverride" type="warning">已覆盖内置</el-tag>
        <el-tag v-if="currentDirty" type="danger">未保存草稿</el-tag>
      </div>
      <div v-if="current" class="preset-toolbar-actions">
        <el-dropdown
          trigger="click"
          :disabled="mutationBusy !== null"
          @command="(command: ContentKind) => addContent(command)"
        >
          <el-button>新增内容块</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="message">预设消息</el-dropdown-item>
              <el-dropdown-item command="lore">Lore 条目</el-dropdown-item>
              <el-dropdown-item command="authorsNote">作者注</el-dropdown-item>
              <el-dropdown-item command="knowledge">知识配置</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button
          :loading="mutationBusy === 'default'"
          :disabled="mutationBusy !== null || isNew || currentDirty || catalog?.globalDefaultPresetId === current.id"
          @click="setGlobalDefault"
        >
          设为全局默认
        </el-button>
        <el-button
          v-if="currentMeta?.hasOverride"
          :loading="mutationBusy === 'revert'"
          :disabled="mutationBusy !== null"
          @click="revertOverride"
        >
          撤销覆盖
        </el-button>
        <el-button
          v-if="currentMeta?.source === 'runtime' && !currentMeta?.hasOverride && !isNew"
          type="danger"
          plain
          :loading="mutationBusy === 'delete'"
          :disabled="mutationBusy !== null || catalog?.globalDefaultPresetId === current.id"
          :title="catalog?.globalDefaultPresetId === current.id ? '请先设置其他全局默认预设' : '删除运行时预设'"
          @click="removeRuntimePreset"
        >
          删除
        </el-button>
      </div>
    </div>

    <template v-if="current">
      <div class="editor-heading">
        <div>
          <p>正在编辑</p>
          <h2>{{ current.displayName || '新建预设' }}</h2>
        </div>
        <dl>
          <div><dt>Canonical ID</dt><dd class="mono">{{ current.id || '尚未填写' }}</dd></div>
          <div><dt>Loaded revision</dt><dd class="mono">{{ currentMeta?.revision?.slice(0, 12) || '尚未加载' }}</dd></div>
        </dl>
      </div>

      <div v-if="fieldIssues.length" class="validation-summary" role="alert">
        <strong>当前草稿有 {{ fieldIssues.length }} 个字段问题，修正后才能保存</strong>
        <button
          v-for="issue in fieldIssues"
          :key="`${issue.path}:${issue.message}`"
          type="button"
          @click="revealIssue(issue)"
        >
          <code>{{ issue.path }}</code>
          <span>{{ issue.message }}</span>
        </button>
      </div>

      <div class="editor-sections">
        <details id="preset-basics" class="editor-section" open>
          <summary><span><strong>基本信息</strong><small>运行时身份、显示名称和触发别名</small></span></summary>
          <div class="section-content grid-2">
            <el-form-item label="Canonical ID">
              <el-input
                v-model="current.id"
                :disabled="!isNew"
                placeholder="lowercase-kebab-case"
              />
              <p class="field-note">创建后不可修改；所有会话和约束只保存这个 ID。</p>
            </el-form-item>
            <el-form-item label="显示名称">
              <el-input v-model="current.displayName" />
            </el-form-item>
            <el-form-item class="wide-field" label="触发别名">
              <el-select
                v-model="current.aliases"
                multiple
                filterable
                allow-create
                default-first-option
                placeholder="输入后回车添加；alias 不参与运行时身份"
              />
            </el-form-item>
          </div>
        </details>

        <details id="preset-messages" class="editor-section" open>
          <summary>
            <span><strong>预设消息</strong><small>角色决定消息协议，作用决定语义锚点</small></span>
            <el-dropdown trigger="click" @command="(command: MessagePurpose | 'plain') => addMessage(command)">
              <el-button size="small" @click.stop>新增消息</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="description">角色描述 · system</el-dropdown-item>
                  <el-dropdown-item command="personality">性格 · system</el-dropdown-item>
                  <el-dropdown-item command="scenario">场景 · system</el-dropdown-item>
                  <el-dropdown-item command="firstMessage">开场消息 · assistant</el-dropdown-item>
                  <el-dropdown-item command="exampleStart">示例用户消息 · user</el-dropdown-item>
                  <el-dropdown-item command="exampleEnd">示例助手消息 · assistant</el-dropdown-item>
                  <el-dropdown-item command="plain" divided>未指定用途</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </summary>
          <div class="section-content">
            <div class="role-guide" aria-label="消息角色含义">
              <span><code>system</code> 规则与约束</span>
              <span><code>user</code> 示例用户消息或静态用户上下文</span>
              <span><code>assistant</code> 示例回复或开场消息</span>
            </div>
            <EmptyState
              v-if="current.messages.length === 0"
              title="这个预设没有消息"
              description="空预设是合法状态；需要角色内容时再新增消息。"
            />
            <article v-for="(message, index) in current.messages" :key="index" class="message-card">
              <header>
                <div>
                  <strong>消息 {{ index + 1 }}</strong>
                  <small>{{ roleHelp(message.role) }}</small>
                </div>
                <div class="row-actions">
                  <el-button text :disabled="index === 0" @click="moveItem(current.messages, index, -1)">上移</el-button>
                  <el-button text :disabled="index === current.messages.length - 1" @click="moveItem(current.messages, index, 1)">下移</el-button>
                  <el-button text type="danger" @click="current.messages.splice(index, 1)">移除</el-button>
                </div>
              </header>
              <div class="message-contract">
                <el-form-item label="消息角色">
                  <el-select v-model="message.role">
                    <el-option
                      v-for="role in messageRoles"
                      :key="role.value"
                      :value="role.value"
                      :label="`${role.label} · ${role.value}`"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="用途 / 锚点">
                  <el-select
                    :model-value="message.purpose"
                    clearable
                    placeholder="未指定"
                    @change="(value: MessagePurpose | undefined) => {
                      if (value) message.purpose = value;
                      else delete message.purpose;
                    }"
                  >
                    <el-option
                      v-for="purpose in purposes"
                      :key="purpose.value"
                      :value="purpose.value"
                      :label="purpose.label"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="内容形式">
                  <el-segmented
                    :model-value="typeof message.content === 'string' ? 'text' : 'blocks'"
                    :options="[{ label: '文本', value: 'text' }, { label: '结构化块', value: 'blocks' }]"
                    @change="(value: 'text' | 'blocks') => setContentMode(message, value)"
                  />
                </el-form-item>
              </div>
              <el-input
                v-if="typeof message.content === 'string'"
                v-model="message.content"
                type="textarea"
                :autosize="{ minRows: 4, maxRows: 18 }"
              />
              <div v-else class="content-blocks">
                <div v-for="(block, blockIndex) in message.content" :key="blockIndex" class="content-block">
                  <el-select
                    :model-value="block.type"
                    :aria-label="`消息 ${index + 1} 内容块 ${blockIndex + 1} 类型`"
                    @change="(value: ContentBlockType) => changeContentBlockType(message, blockIndex, value)"
                  >
                    <el-option v-for="type in ['text', 'image', 'file', 'audio', 'video']" :key="type" :value="type" />
                  </el-select>
                  <el-input v-if="block.type === 'text'" v-model="block.text" type="textarea" :rows="2" />
                  <template v-else>
                    <el-input v-model="block.url" placeholder="资源 URL" />
                    <el-input
                      v-if="block.type !== 'image'"
                      :model-value="optionalString(block.mimeType)"
                      placeholder="MIME type（可选）"
                      @input="(value: string) => assignOptionalString(block, 'mimeType', value)"
                    />
                    <el-select
                      v-else
                      :model-value="block.detail"
                      clearable
                      placeholder="图像精度"
                      @change="(value: 'auto' | 'low' | 'high' | undefined) => {
                        if (value) block.detail = value;
                        else delete block.detail;
                      }"
                    >
                      <el-option v-for="detail in ['auto', 'low', 'high']" :key="detail" :value="detail" />
                    </el-select>
                  </template>
                  <el-button text type="danger" @click="message.content.splice(blockIndex, 1)">移除</el-button>
                </div>
                <el-button size="small" @click="addContentBlock(message)">添加内容块</el-button>
              </div>
            </article>
          </div>
        </details>

        <details id="preset-input-format" class="editor-section">
          <summary><span><strong>用户输入格式</strong><small>渲染本轮用户输入的模板</small></span></summary>
          <div class="section-content">
            <el-switch
              :model-value="current.inputFormat !== null"
              active-text="启用自定义格式"
              @change="(enabled: unknown) => { current!.inputFormat = enabled ? '{prompt}' : null; }"
            />
            <el-input
              v-if="current.inputFormat !== null"
              v-model="current.inputFormat"
              class="spaced-input"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 10 }"
            />
          </div>
        </details>

        <details id="preset-lore" class="editor-section">
          <summary>
            <span><strong>世界书 / Lore</strong><small>匹配规则、插入位置和内容条目</small></span>
            <el-button
              size="small"
              @click.stop="current.lore.entries.push({ keywords: [], content: '', enabled: true })"
            >
              新增 Lore
            </el-button>
          </summary>
          <div class="section-content">
            <h3>全局默认参数</h3>
            <div class="grid-3">
              <el-form-item label="扫描深度">
                <el-input-number
                  :model-value="current.lore.defaults.scanDepth"
                  :min="0"
                  @change="(value: number | undefined) => assignOptionalNumber(current!.lore.defaults, 'scanDepth', value)"
                />
              </el-form-item>
              <el-form-item label="Token 上限">
                <el-input-number
                  :model-value="current.lore.defaults.tokenLimit"
                  :min="1"
                  @change="(value: number | undefined) => assignOptionalNumber(current!.lore.defaults, 'tokenLimit', value)"
                />
              </el-form-item>
              <el-form-item label="递归深度">
                <el-input-number
                  :model-value="current.lore.defaults.maxRecursionDepth"
                  :min="0"
                  @change="(value: number | undefined) => assignOptionalNumber(current!.lore.defaults, 'maxRecursionDepth', value)"
                />
              </el-form-item>
              <el-form-item label="插入位置">
                <el-select
                  :model-value="current.lore.defaults.insertPosition"
                  clearable
                  @change="(value: LoreInsertPosition | undefined) => {
                    if (value) current!.lore.defaults.insertPosition = value;
                    else delete current!.lore.defaults.insertPosition;
                  }"
                >
                  <el-option v-for="position in lorePositions" :key="position.value" :value="position.value" :label="position.label" />
                </el-select>
              </el-form-item>
              <el-form-item label="递归扫描"><el-switch v-model="current.lore.defaults.recursiveScan" /></el-form-item>
            </div>
            <article v-for="(entry, index) in current.lore.entries" :key="index" class="sub-card">
              <header>
                <strong>Lore {{ index + 1 }}</strong>
                <div class="row-actions">
                  <el-button text :disabled="index === 0" @click="moveItem(current.lore.entries, index, -1)">上移</el-button>
                  <el-button text :disabled="index === current.lore.entries.length - 1" @click="moveItem(current.lore.entries, index, 1)">下移</el-button>
                  <el-button text type="danger" @click="current.lore.entries.splice(index, 1)">移除</el-button>
                </div>
              </header>
              <div class="grid-2">
                <el-form-item label="关键词">
                  <el-select v-model="entry.keywords" multiple filterable allow-create default-first-option />
                </el-form-item>
                <el-form-item label="插入位置">
                  <el-select
                    :model-value="entry.insertPosition"
                    clearable
                    @change="(value: LoreInsertPosition | undefined) => {
                      if (value) entry.insertPosition = value;
                      else delete entry.insertPosition;
                    }"
                  >
                    <el-option v-for="position in lorePositions" :key="position.value" :value="position.value" :label="position.label" />
                  </el-select>
                </el-form-item>
              </div>
              <el-input v-model="entry.content" type="textarea" :autosize="{ minRows: 3, maxRows: 12 }" />
              <div class="grid-3 nested-form">
                <el-form-item label="扫描深度">
                  <el-input-number
                    :model-value="entry.scanDepth"
                    :min="0"
                    @change="(value: number | undefined) => assignOptionalNumber(entry, 'scanDepth', value)"
                  />
                </el-form-item>
                <el-form-item label="最大递归深度">
                  <el-input-number
                    :model-value="entry.maxRecursionDepth"
                    :min="0"
                    @change="(value: number | undefined) => assignOptionalNumber(entry, 'maxRecursionDepth', value)"
                  />
                </el-form-item>
                <el-form-item label="匹配顺序">
                  <el-input-number
                    :model-value="entry.order"
                    @change="(value: number | undefined) => assignOptionalNumber(entry, 'order', value)"
                  />
                </el-form-item>
              </div>
              <div class="inline-switches">
                <el-checkbox v-model="entry.enabled">启用</el-checkbox>
                <el-checkbox v-model="entry.constant">始终注入</el-checkbox>
                <el-checkbox v-model="entry.matchWholeWord">整词匹配</el-checkbox>
                <el-checkbox v-model="entry.caseSensitive">区分大小写</el-checkbox>
                <el-checkbox v-model="entry.recursiveScan">递归扫描</el-checkbox>
              </div>
            </article>
          </div>
        </details>

        <details id="preset-authors-note" class="editor-section">
          <summary><span><strong>作者注</strong><small>按深度或角色定义位置插入的补充约束</small></span></summary>
          <div class="section-content">
            <el-switch :model-value="current.authorsNote !== null" active-text="启用作者注" @change="setAuthorsNote" />
            <div v-if="current.authorsNote" class="nested-form">
              <el-input v-model="current.authorsNote.content" type="textarea" :autosize="{ minRows: 3, maxRows: 12 }" />
              <div class="grid-3">
                <el-form-item label="插入位置">
                  <el-select v-model="current.authorsNote.insertPosition">
                    <el-option value="afterCharacterDefinitions" label="角色定义后" />
                    <el-option value="inChat" label="聊天历史内" />
                  </el-select>
                </el-form-item>
                <el-form-item label="插入深度"><el-input-number v-model="current.authorsNote.insertDepth" :min="0" /></el-form-item>
                <el-form-item label="插入频率"><el-input-number v-model="current.authorsNote.insertFrequency" :min="0" /></el-form-item>
              </div>
            </div>
          </div>
        </details>

        <details id="preset-knowledge" class="editor-section">
          <summary><span><strong>知识</strong><small>预设绑定的知识来源及渲染模板</small></span></summary>
          <div class="section-content">
            <el-switch :model-value="current.knowledge !== null" active-text="启用知识配置" @change="setKnowledge" />
            <div v-if="current.knowledge" class="nested-form">
              <el-form-item label="知识来源">
                <el-select v-model="current.knowledge.sources" multiple filterable allow-create default-first-option />
              </el-form-item>
              <el-form-item label="知识 Prompt">
                <el-input
                  :model-value="optionalString(current.knowledge.prompt)"
                  type="textarea"
                  :autosize="{ minRows: 3, maxRows: 10 }"
                  @input="(value: string) => assignOptionalString(current!.knowledge!, 'prompt', value)"
                />
              </el-form-item>
            </div>
          </div>
        </details>

        <details id="preset-prompt-config" class="editor-section">
          <summary><span><strong>Prompt 配置</strong><small>输出预算、长记忆、Lore、ReAct 与后处理器</small></span></summary>
          <div class="section-content">
            <el-form-item label="最大输出 Token"><el-input-number v-model="current.promptConfig.maxOutputToken" :min="1" /></el-form-item>
            <div class="template-grid">
              <el-form-item label="Long memory prompt">
                <el-input
                  :model-value="optionalString(current.promptConfig.longMemoryPrompt)"
                  type="textarea"
                  :rows="4"
                  @input="(value: string) => setPromptText('longMemoryPrompt', value)"
                />
              </el-form-item>
              <el-form-item label="Lore prompt">
                <el-input
                  :model-value="optionalString(current.promptConfig.loreBooksPrompt)"
                  type="textarea"
                  :rows="4"
                  @input="(value: string) => setPromptText('loreBooksPrompt', value)"
                />
              </el-form-item>
              <el-form-item label="Long memory extract prompt">
                <el-input
                  :model-value="optionalString(current.promptConfig.longMemoryExtractPrompt)"
                  type="textarea"
                  :rows="4"
                  @input="(value: string) => setPromptText('longMemoryExtractPrompt', value)"
                />
              </el-form-item>
              <el-form-item label="Long memory new-question prompt">
                <el-input
                  :model-value="optionalString(current.promptConfig.longMemoryNewQuestionPrompt)"
                  type="textarea"
                  :rows="4"
                  @input="(value: string) => setPromptText('longMemoryNewQuestionPrompt', value)"
                />
              </el-form-item>
              <el-form-item label="ReAct instruction">
                <el-input
                  :model-value="optionalString(current.promptConfig.reActInstruction)"
                  type="textarea"
                  :rows="4"
                  @input="(value: string) => setPromptText('reActInstruction', value)"
                />
              </el-form-item>
            </div>
            <div class="post-handler">
              <el-switch
                :model-value="current.promptConfig.postHandler !== undefined"
                active-text="启用已注册后处理器"
                @change="setPostHandler"
              />
              <template v-if="current.promptConfig.postHandler">
                <div class="grid-3 nested-form">
                  <el-form-item label="Handler ID"><el-input v-model="current.promptConfig.postHandler.id" /></el-form-item>
                  <el-form-item label="Prefix"><el-input v-model="current.promptConfig.postHandler.prefix" /></el-form-item>
                  <el-form-item label="Postfix"><el-input v-model="current.promptConfig.postHandler.postfix" /></el-form-item>
                </div>
                <el-checkbox v-model="current.promptConfig.postHandler.censor">启用内容审查</el-checkbox>
                <div class="variables-editor">
                  <div class="prompt-head">
                    <strong>Variables</strong>
                    <el-button size="small" @click="addPostVariable">添加变量</el-button>
                  </div>
                  <div
                    v-for="(value, key) in current.promptConfig.postHandler.variables"
                    :key="String(key)"
                    class="variable-row"
                  >
                    <el-input
                      :model-value="String(key)"
                      @change="(next: string) => renamePostVariable(String(key), next)"
                    />
                    <el-input
                      :model-value="value"
                      @input="(next: string) => { current!.promptConfig.postHandler!.variables[String(key)] = next; }"
                    />
                    <el-button text type="danger" @click="delete current.promptConfig.postHandler!.variables[String(key)]">移除</el-button>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </details>
      </div>
    </template>
    <EmptyState v-else title="没有可编辑的预设" description="运行时必须存在有效的全局默认预设。" />
  </article>

  <article id="context-inspector" class="panel context-inspector">
    <div class="panel-head">
      <div>
        <h2>模型上下文结构</h2>
        <p>结构定义与最近一次真实请求使用同一套 provenance contract</p>
      </div>
      <div class="context-controls">
        <el-select
          v-model="selectedConversationId"
          filterable
          clearable
          aria-label="选择会话查看最近模型上下文"
          :loading="targetsLoading"
          placeholder="选择会话查看最近实况"
          @change="changeConversation"
        >
          <el-option
            v-for="target in contextTargets"
            :key="target.conversationId"
            :value="target.conversationId"
            :label="target.label"
          />
        </el-select>
        <el-button :disabled="!selectedConversationId" :loading="contextLoading" @click="loadSnapshot">刷新实况</el-button>
      </div>
    </div>

    <div class="panel-body context-body">
      <section class="blueprint-column">
        <div class="context-section-heading">
          <div><strong>Canonical pipeline</strong><small>{{ blueprint?.presetRevision.slice(0, 12) || '未加载' }}</small></div>
          <el-tag v-if="currentDirty" type="warning">草稿尚未进入结构</el-tag>
        </div>
        <p v-if="blueprintError" class="context-error">{{ blueprintError }}</p>
        <div v-else class="pipeline">
          <details v-for="section in sortedBlueprintSections" :key="section.id" class="pipeline-stage" open>
            <summary>
              <span class="stage-order">{{ section.order }}</span>
              <span><strong>{{ section.label }}</strong><small>{{ section.description }}</small></span>
              <el-tag size="small" :type="section.dynamic ? 'warning' : 'info'">
                {{ section.dynamic ? '动态' : '静态' }}
              </el-tag>
            </summary>
            <div class="stage-sources">
              <div v-for="source in section.sources" :key="source.id" class="stage-source">
                <header>
                  <strong>{{ source.label }}</strong>
                  <span class="mono">{{ source.path || source.id }}</span>
                </header>
                <div class="source-tags">
                  <el-tag v-if="source.role" size="small">{{ source.role }}</el-tag>
                  <el-tag v-if="source.purpose" size="small" type="info">{{ source.purpose }}</el-tag>
                </div>
                <pre v-if="source.content !== undefined">{{ formatContent(source.content) }}</pre>
              </div>
            </div>
          </details>
        </div>
      </section>

      <section class="snapshot-column">
        <div class="context-section-heading">
          <div><strong>最近请求实况</strong><small>Provider 序列化之前的最终语义上下文</small></div>
          <el-button
            v-if="snapshot?.effectivePresetId && snapshot.effectivePresetId !== current?.id"
            size="small"
            @click="editEffectivePreset"
          >
            编辑生效预设
          </el-button>
        </div>
        <p v-if="targetsError" class="context-error" role="alert">{{ targetsError }}</p>
        <div v-if="selectedTarget" class="target-summary">
          <span>会话目标</span>
          <strong>{{ selectedTarget.label }}</strong>
          <strong class="mono">{{ selectedTarget.scope || '未标记 scope' }}</strong>
          <div class="resolution-chain">
            <span>模型、预设和命中优先级只采用真实请求 snapshot</span>
            <code>{{ selectedTarget.conversationId }}</code>
          </div>
        </div>
        <EmptyState
          v-if="!selectedConversationId"
          title="选择一个会话"
          description="这里会展示该会话最近一次实际模型请求。"
        />
        <EmptyState
          v-else-if="!snapshot"
          title="暂无上下文实况"
          :description="snapshotUnavailable || '请先在这个会话中产生一条新模型请求。'"
        />
        <template v-else>
          <div class="snapshot-metrics">
            <div><span>Effective model</span><strong class="mono">{{ snapshot.model }}</strong></div>
            <div><span>Transport model</span><strong class="mono">{{ snapshot.transportModel || '未上报' }}</strong></div>
            <div><span>生效预设</span><strong class="mono">{{ snapshot.effectivePresetId || 'unknown' }}</strong></div>
            <div><span>Context 使用率</span><strong>{{ formatPercent(snapshot.contextRatio) }}</strong></div>
            <div><span>Effective crop limit</span><strong>{{ snapshot.estimatedTokens }} / {{ snapshot.contextLimit }}</strong></div>
            <div><span>Physical context size</span><strong>{{ snapshot.modelContextSize }}</strong></div>
            <div><span>消息</span><strong>{{ snapshot.finalCount }} / {{ snapshot.assembledCount }}</strong></div>
          </div>
          <dl class="snapshot-meta">
            <div><dt>请求</dt><dd class="mono">{{ snapshot.requestId }}</dd></div>
            <div><dt>Provider call</dt><dd class="mono">{{ snapshot.callId }} · #{{ snapshot.callOrdinal }}</dd></div>
            <div><dt>时间</dt><dd>{{ formatTimestamp(snapshot.createdAt) }}</dd></div>
            <div><dt>Provider / mode</dt><dd>{{ snapshot.platform }} · {{ snapshot.requestMode || 'default' }} · {{ snapshot.stream ? 'stream' : 'non-stream' }}</dd></div>
            <div><dt>Preset revision</dt><dd class="mono">{{ snapshot.presetRevision?.slice(0, 12) || 'unknown' }}</dd></div>
            <div><dt>裁剪</dt><dd>{{ snapshot.truncated ? `已移除 ${droppedMessages.length} 项` : '未裁剪' }}</dd></div>
            <div><dt>Context size</dt><dd>{{ snapshot.contextSize ?? '未上报' }} tokens</dd></div>
            <div><dt>Provider usage</dt><dd>{{ formatProviderUsage(snapshot) }}</dd></div>
          </dl>
          <div class="resolution-chain">
            <span>Snapshot preset resolution</span>
            <code>{{ resolutionSourceLabel(snapshot.presetResolution.source) }}</code>
            <code>{{ snapshot.presetResolution.presetId }}</code>
            <code>{{ snapshot.presetResolution.bindingKey }}</code>
          </div>

          <details class="snapshot-group" open>
            <summary>最终发送消息 · {{ includedMessages.length }}</summary>
            <details
              v-for="message in includedMessages"
              :key="message.id"
              class="snapshot-message"
              :open="!shouldCollapseMessage(message)"
            >
              <summary>
                <span class="message-index">{{ message.index + 1 }}</span>
                <el-tag size="small">{{ message.role }}</el-tag>
                <strong>{{ message.source }}</strong>
                <small>{{ message.stage }} · {{ message.estimatedTokens }} tokens</small>
              </summary>
              <div class="message-provenance">
                <el-tag v-if="message.purpose" size="small" type="info">purpose · {{ message.purpose }}</el-tag>
                <el-tag v-if="message.authority" size="small">authority · {{ message.authority }}</el-tag>
                <el-tag v-if="message.trust" size="small" type="warning">trust · {{ message.trust }}</el-tag>
                <el-tag v-if="message.ttl" size="small" type="success">ttl · {{ message.ttl }}</el-tag>
              </div>
              <p v-if="message.sourcePath" class="mono">{{ message.sourcePath }}</p>
              <pre>{{ formatContent(message.content) }}</pre>
            </details>
          </details>

          <details v-if="droppedMessages.length" class="snapshot-group dropped-group">
            <summary>被预算移除 · {{ droppedMessages.length }}</summary>
            <details v-for="message in droppedMessages" :key="message.id" class="snapshot-message dropped">
              <summary>
                <span class="message-index">×</span>
                <el-tag size="small" type="danger">{{ message.role }}</el-tag>
                <strong>{{ message.source }}</strong>
                <small>{{ message.dropReason || 'budget' }}</small>
              </summary>
              <div class="message-provenance">
                <el-tag v-if="message.purpose" size="small" type="info">purpose · {{ message.purpose }}</el-tag>
                <el-tag v-if="message.authority" size="small">authority · {{ message.authority }}</el-tag>
                <el-tag v-if="message.trust" size="small" type="warning">trust · {{ message.trust }}</el-tag>
                <el-tag v-if="message.ttl" size="small" type="success">ttl · {{ message.ttl }}</el-tag>
              </div>
              <pre>{{ formatContent(message.content) }}</pre>
            </details>
          </details>

          <details v-if="snapshot.tools.length" class="snapshot-group">
            <summary>工具定义 · {{ snapshot.tools.length }}</summary>
            <article v-for="tool in snapshot.tools" :key="tool.name" class="tool-card">
              <strong class="mono">{{ tool.name }}</strong>
              <p>{{ tool.description }}</p>
              <pre>{{ formatContent(tool.schema) }}</pre>
            </article>
          </details>
        </template>
      </section>
    </div>
  </article>
</template>

<style scoped>
.preset-workspace { overflow: hidden; }
.top-error { margin: 16px 20px 0; }
.preset-toolbar { display: grid; grid-template-columns: minmax(280px, 1fr) auto auto; align-items: end; gap: 18px; padding: 18px 20px; border-bottom: 1px solid var(--line); background: #fbfcff; }
.preset-picker { display: grid; gap: 7px; max-width: 560px; }
.preset-picker > label { color: #566174; font-size: 11px; font-weight: 700; }
.preset-option { width: 100%; display: flex; align-items: center; gap: 8px; }
.preset-option small { margin-right: auto; color: #929bab; font-family: monospace; }
.preset-status, .preset-toolbar-actions, .row-actions, .inline-switches, .context-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.preset-toolbar-actions :deep(.el-button + .el-button), .row-actions :deep(.el-button + .el-button), .context-controls :deep(.el-button + .el-button) { margin-left: 0; }
.editor-heading { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 24px 26px 18px; }
.editor-heading p { margin: 0 0 3px; color: #929aaa; font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.editor-heading h2 { margin: 0; font-size: 22px; }
.editor-heading dl { display: flex; gap: 28px; margin: 0; }
.editor-heading dl div { display: grid; gap: 4px; }
.editor-heading dt { color: #929aaa; font-size: 9px; text-transform: uppercase; }
.editor-heading dd { margin: 0; color: #48566c; }
.validation-summary { display: grid; gap: 7px; margin: 0 24px 14px; padding: 13px; border: 1px solid #f0cfd5; border-radius: 9px; color: #883b48; background: #fff7f8; }
.validation-summary > strong { font-size: 11px; }
.validation-summary button { display: grid; grid-template-columns: minmax(140px, .35fr) minmax(0, 1fr); gap: 10px; width: 100%; padding: 7px 9px; border: 0; border-radius: 6px; color: #75424a; background: rgba(255, 255, 255, .8); font: inherit; text-align: left; cursor: pointer; }
.validation-summary button:hover, .validation-summary button:focus-visible { outline: 2px solid #e6aab4; outline-offset: 1px; }
.validation-summary code { font-size: 9px; word-break: break-all; }
.validation-summary span { font-size: 10px; }
.editor-sections { display: grid; gap: 14px; padding: 0 24px 28px; }
.editor-section { border: 1px solid #e2e7ef; border-radius: 11px; background: #fff; scroll-margin-top: 82px; }
.editor-section > summary { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 13px 16px; cursor: pointer; list-style: none; }
.editor-section > summary::-webkit-details-marker { display: none; }
.editor-section > summary > span { display: grid; gap: 3px; }
.editor-section > summary strong { color: #303b4e; font-size: 13px; }
.editor-section > summary small { color: #8b95a5; font-size: 10px; }
.section-content { padding: 18px; border-top: 1px solid var(--line); }
.section-content h3 { margin: 0 0 14px; color: #526075; font-size: 11px; }
.grid-2, .grid-3 { display: grid; gap: 14px; }
.grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.wide-field { grid-column: 1 / -1; }
.field-note { margin: 5px 0 0; color: #929bab; font-size: 9px; }
.message-card, .sub-card { padding: 15px; border: 1px solid #e2e7ef; border-radius: 10px; background: #fbfcfe; }
.role-guide { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 12px; padding: 10px; border-radius: 8px; color: #69758a; background: #f5f7fb; font-size: 10px; }
.role-guide span { display: inline-flex; align-items: center; gap: 5px; }
.role-guide code { color: #4262b4; font-weight: 700; }
.message-card + .message-card, .sub-card + .sub-card { margin-top: 12px; }
.message-card > header, .sub-card > header { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
.message-card > header > div:first-child { display: grid; gap: 2px; }
.message-card > header small { color: #8a95a6; font-size: 9px; }
.message-contract { display: grid; grid-template-columns: minmax(160px, .7fr) minmax(180px, .8fr) minmax(210px, 1fr); gap: 12px; }
.content-blocks { display: grid; gap: 10px; }
.content-block { display: grid; grid-template-columns: 120px minmax(220px, 1fr) minmax(160px, .5fr) auto; align-items: start; gap: 9px; }
.spaced-input, .nested-form { margin-top: 14px; }
.inline-switches { margin-top: 12px; }
.template-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.post-handler { padding-top: 16px; border-top: 1px solid var(--line); }
.variables-editor { margin-top: 14px; }
.prompt-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; }
.variable-row { display: grid; grid-template-columns: minmax(140px, .4fr) minmax(240px, 1fr) auto; gap: 9px; margin-bottom: 8px; }
.context-inspector { margin-top: 18px; overflow: hidden; scroll-margin-top: 70px; }
.context-controls { min-width: 440px; justify-content: flex-end; }
.context-controls .el-select { width: 320px; }
.context-body { display: grid; grid-template-columns: minmax(0, .9fr) minmax(420px, 1.1fr); gap: 22px; }
.blueprint-column, .snapshot-column { min-width: 0; }
.context-section-heading { min-height: 38px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.context-section-heading > div { display: grid; gap: 3px; }
.context-section-heading small { color: #919aaa; font-size: 9px; }
.context-error { padding: 12px; border-radius: 8px; color: #a74451; background: #fff1f3; font-size: 11px; }
.pipeline { display: grid; gap: 9px; }
.pipeline-stage { border: 1px solid #e1e7f0; border-radius: 9px; background: #fbfcfe; }
.pipeline-stage > summary { display: grid; grid-template-columns: 25px minmax(0, 1fr) auto; align-items: center; gap: 9px; padding: 11px; cursor: pointer; list-style: none; }
.pipeline-stage > summary::-webkit-details-marker { display: none; }
.pipeline-stage > summary > span:nth-child(2) { display: grid; gap: 2px; }
.pipeline-stage > summary small { color: #8e98a8; font-size: 9px; }
.stage-order, .message-index { width: 23px; height: 23px; display: inline-grid; place-content: center; border-radius: 50%; color: #4262b4; background: #eaf0ff; font-size: 9px; font-weight: 800; }
.stage-sources { display: grid; gap: 8px; padding: 0 10px 10px 44px; }
.stage-source { padding: 10px; border: 1px solid #e5e9f0; border-radius: 7px; background: #fff; }
.stage-source header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.source-tags { display: flex; gap: 5px; margin-top: 7px; }
pre { max-height: 320px; overflow: auto; margin: 9px 0 0; padding: 10px; border-radius: 7px; color: #39465c; background: #f4f6f9; font-family: "SFMono-Regular", Consolas, monospace; font-size: 10px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.snapshot-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.snapshot-metrics > div { padding: 12px; border: 1px solid #e2e7ef; border-radius: 9px; background: #fbfcfe; }
.snapshot-metrics span { display: block; color: #8e98a8; font-size: 9px; }
.snapshot-metrics strong { display: block; margin-top: 5px; color: #354156; font-size: 13px; }
.snapshot-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 14px; margin: 14px 0; padding: 12px; border-radius: 9px; background: #f6f8fb; }
.snapshot-meta div { min-width: 0; }
.snapshot-meta dt { color: #8f98a7; font-size: 9px; }
.snapshot-meta dd { overflow: hidden; margin: 3px 0 0; color: #4a5669; text-overflow: ellipsis; white-space: nowrap; }
.target-summary { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 7px 12px; margin-bottom: 12px; padding: 10px 12px; border: 1px solid #e0e7f2; border-radius: 8px; background: #f8faff; }
.target-summary > span { color: #8993a4; font-size: 9px; }
.target-summary > strong { overflow: hidden; color: #455268; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.target-summary .resolution-chain { grid-column: 1 / -1; margin: 2px 0 0; }
.resolution-chain { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.resolution-chain span { color: #8993a4; font-size: 9px; }
.resolution-chain code { padding: 3px 6px; border-radius: 5px; color: #4963a4; background: #eef2fd; font-size: 9px; }
.snapshot-group { margin-top: 10px; border: 1px solid #e2e7ef; border-radius: 9px; }
.snapshot-group > summary { padding: 11px 13px; color: #46546a; cursor: pointer; font-size: 11px; font-weight: 700; }
.snapshot-message { padding: 0; border-top: 1px solid #e8ecf2; }
.tool-card { padding: 11px 13px; border-top: 1px solid #e8ecf2; }
.snapshot-message > summary { display: flex; align-items: center; gap: 7px; padding: 11px 13px; cursor: pointer; list-style: none; }
.snapshot-message > summary::-webkit-details-marker { display: none; }
.snapshot-message > summary small { margin-left: auto; color: #8c96a6; font-size: 9px; }
.snapshot-message > pre, .snapshot-message > p, .snapshot-message > .message-provenance { margin-inline: 13px; }
.snapshot-message > pre { margin-bottom: 13px; }
.message-provenance { display: flex; flex-wrap: wrap; gap: 5px; }
.snapshot-message > p { margin: 7px 13px 0; color: #8b95a5; }
.snapshot-message.dropped { opacity: .72; background: #fff9fa; }
.dropped-group { border-color: #f0d7dc; }
.tool-card p { margin: 5px 0; color: #788397; font-size: 10px; }
@media (max-width: 1100px) {
  .preset-toolbar { grid-template-columns: 1fr auto; }
  .preset-toolbar-actions { grid-column: 1 / -1; }
  .context-body { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .preset-toolbar { grid-template-columns: 1fr; align-items: stretch; }
  .preset-toolbar-actions { grid-column: auto; }
  .editor-heading { align-items: flex-start; flex-direction: column; }
  .editor-heading dl { flex-direction: column; gap: 9px; }
  .editor-sections { padding-inline: 12px; }
  .validation-summary { margin-inline: 12px; }
  .grid-2, .grid-3, .template-grid, .message-contract, .content-block, .snapshot-meta, .target-summary { grid-template-columns: 1fr; }
  .target-summary .resolution-chain { grid-column: auto; }
  .snapshot-metrics { grid-template-columns: 1fr; }
  .preset-toolbar-actions > *, .preset-toolbar-actions :deep(.el-button) { max-width: 100%; }
  .message-card > header, .sub-card > header { align-items: flex-start; flex-direction: column; }
  .row-actions { width: 100%; }
  .snapshot-message > summary { align-items: flex-start; flex-wrap: wrap; }
  .snapshot-message > summary small { width: 100%; margin-left: 30px; }
  .context-controls { min-width: 0; width: 100%; }
  .context-controls .el-select { width: 100%; }
  .panel-head { align-items: flex-start; flex-direction: column; }
  .context-body { padding: 14px; }
  .stage-sources { padding-left: 10px; }
}
</style>
