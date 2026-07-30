<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import openAiIcon from '@lobehub/icons-static-svg/icons/openai.svg?url';
import githubCopilotIcon from '@lobehub/icons-static-svg/icons/githubcopilot.svg?url';
import deepSeekIcon from '@lobehub/icons-static-svg/icons/deepseek-color.svg?url';
import siliconFlowIcon from '@lobehub/icons-static-svg/icons/siliconcloud-color.svg?url';
import volcengineIcon from '@lobehub/icons-static-svg/icons/volcengine-color.svg?url';
import xiaomiMimoIcon from '@lobehub/icons-static-svg/icons/xiaomimimo.svg?url';
import {
  connectionIdSchema,
  emptyRequestSchema,
  modelAdminAggregateSchema,
  modelCatalogResponseSchema,
  modelConfigPutSchema,
  modelConnectionAuthStateSchema,
  modelConnectionProbeResponseSchema,
  modelIdSchema,
  modelOAuthPollRequestSchema,
  type ModelCatalogEntry,
  type ModelCatalogResponse,
  type ModelConfigAdminAggregate,
  type ModelConfigDraft,
  type ModelConnectionAuthState,
} from '@contracts';
import { ApiError, api, jsonBody } from '@/api/client';
import PendingChangesBar from '@/components/PendingChangesBar.vue';
import { useRuntimeStore } from '@/stores/runtime';
import { refreshRuntimeOverview } from '@/stores/runtime-refresh';
import {
  allowedBindingModes,
  buildModelConfigPutInput,
  compatibleConnectionIds,
  createCatalogModelProfile,
  createModelConfigDraft,
  createSecretDrafts,
  errorMessage,
  incompatibleWorkloadsForModel,
  isModelCompatible,
  isModelDraftDirty,
  isSavedConnectionOperationTarget,
  loadModelPageConfiguration,
  orderModelSettingBindings,
  replaceBindingMode,
  structuredOutputProtocolsForRequestMode,
  trimUnreferencedCatalogModels,
  withModelRequestMode,
  withStructuredOutputProtocol,
  type SecretDraft,
  type SecretDrafts,
} from './model-page-state';

type ConnectionDraft = ModelConfigDraft['connections'][number];
type ModelProfileDraft = ModelConfigDraft['models'][number];
type BindingDraft = ModelConfigDraft['bindings'][number];
type BindingMode = BindingDraft['mode'];
type AdapterType = ConnectionDraft['adapter'];
type ManualAuthKind = Extract<ConnectionDraft['auth'], { kind: 'none' | 'apiKey' }>['kind'];
type ModelChoice = {
  key: string;
  value: string;
  label: string;
};

type ConnectionBrand = {
  icon: string;
  tone: 'openai' | 'copilot' | 'deepseek' | 'siliconflow' | 'volcengine' | 'xiaomi';
};

const WORKLOAD_DETAILS: Record<string, {
  label: string;
}> = {
  'main.chat': {
    label: '主对话',
  },
  'memory.extract': {
    label: '记忆提炼',
  },
  'affinity.analysis': {
    label: '关系分析',
  },
  'naturalTrigger.decision': {
    label: '自然触发判断',
  },
  'agent.subagent.default': {
    label: 'Sub-Agent 默认模型',
  },
  'sticker.index': {
    label: '表情索引',
  },
};

const route = useRoute();
const runtime = useRuntimeStore();
const requestedWorkload = computed(() => typeof route.query.workload === 'string'
  ? route.query.workload
  : '');
const MODE_LABELS: Record<BindingMode, string> = {
  dedicated: '专用模型',
  disabled: '禁用',
  inheritMain: '继承主对话',
  inheritInvocation: '继承调用会话',
};

const saved = ref<ModelConfigAdminAggregate | null>(null);
const draft = ref<ModelConfigDraft | null>(null);
const secretDrafts = reactive<SecretDrafts>({});
const selectedConnectionId = ref('');
const connectionQuery = ref('');
const modelLoadError = ref<string | null>(null);
const loading = ref(false);
const saving = ref(false);
const operationBusy = ref<string | null>(null);
const catalogByConnection = reactive<Record<string, ModelCatalogResponse | undefined>>({});
const probeByConnection = reactive<Record<string, {
  checkedAt: string;
  latencyMs: number;
} | undefined>>({});
const createConnectionOpen = ref(false);
const createConnection = reactive<{
  id: string;
  displayName: string;
  adapter: AdapterType;
  baseUrl: string;
}>({
  id: '',
  displayName: '',
  adapter: 'openaiCompatible',
  baseUrl: '',
});

const selectedConnection = computed(() => draft.value?.connections.find(
  (connection) => connection.id === selectedConnectionId.value,
) ?? null);
const selectedConnectionModels = computed(() => draft.value?.models.filter(
  (model) => model.connectionId === selectedConnectionId.value,
) ?? []);
const filteredConnections = computed(() => {
  const query = connectionQuery.value.trim().toLocaleLowerCase();
  const connections = draft.value?.connections ?? [];
  if (!query) return connections;
  return connections.filter((connection) => (
    `${connection.displayName} ${connection.id} ${connection.adapter}`
      .toLocaleLowerCase()
      .includes(query)
  ));
});
const hasUnsavedChanges = computed(() => Boolean(
  saved.value
  && draft.value
  && isModelDraftDirty(saved.value, draft.value, secretDrafts),
));
const savedConnection = computed(() => saved.value?.connections.find(
  (connection) => connection.id === selectedConnectionId.value,
) ?? null);
const canOperateSelectedConnection = computed(() => Boolean(
  saved.value
  && draft.value
  && isSavedConnectionOperationTarget(
    saved.value,
    draft.value,
    secretDrafts,
    selectedConnectionId.value,
  ),
));
const selectedAuthState = computed(() => connectionAuthState(selectedConnectionId.value));
const orderedBindings = computed(() => orderModelSettingBindings(
  draft.value?.bindings ?? [],
));

function connectionConfigured(connectionId: string): boolean {
  const status = connectionAuthState(connectionId)?.status;
  return status === 'ready' || status === 'not_required';
}

function connectionBrand(connection: ConnectionDraft): ConnectionBrand {
  if (connection.adapter === 'codexBridge') {
    return { icon: openAiIcon, tone: 'openai' };
  }
  if (connection.adapter === 'copilotBridge') {
    return { icon: githubCopilotIcon, tone: 'copilot' };
  }
  let hostname = '';
  try {
    hostname = new URL(connection.baseUrl ?? '').hostname.toLocaleLowerCase();
  } catch {
    return { icon: openAiIcon, tone: 'openai' };
  }
  if (hostname === 'api.siliconflow.cn') {
    return { icon: siliconFlowIcon, tone: 'siliconflow' };
  }
  if (hostname === 'api.deepseek.com') {
    return { icon: deepSeekIcon, tone: 'deepseek' };
  }
  if (hostname.endsWith('.volces.com')) {
    return { icon: volcengineIcon, tone: 'volcengine' };
  }
  if (hostname.endsWith('.xiaomimimo.com')) {
    return { icon: xiaomiMimoIcon, tone: 'xiaomi' };
  }
  return { icon: openAiIcon, tone: 'openai' };
}

function hydrate(aggregate: ModelConfigAdminAggregate): void {
  const previousSelection = selectedConnectionId.value;
  saved.value = aggregate;
  draft.value = createModelConfigDraft(aggregate);
  for (const key of Object.keys(secretDrafts)) delete secretDrafts[key];
  Object.assign(secretDrafts, createSecretDrafts(aggregate));
  const connections = draft.value.connections;
  selectedConnectionId.value = connections.some((item) => item.id === previousSelection)
    ? previousSelection
    : connections[0]?.id ?? '';
  for (const key of Object.keys(catalogByConnection)) delete catalogByConnection[key];
  for (const key of Object.keys(probeByConnection)) delete probeByConnection[key];
  if (requestedWorkload.value) {
    void nextTick(() => {
      const target = [...document.querySelectorAll<HTMLElement>('[data-workload]')]
        .find((element) => element.dataset.workload === requestedWorkload.value);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
}

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const result = await loadModelPageConfiguration(
      api('/models', modelAdminAggregateSchema),
      hydrate,
    );
    modelLoadError.value = result.requiredError;
  } finally {
    loading.value = false;
  }
}

async function discardChanges(): Promise<void> {
  if (!hasUnsavedChanges.value) return;
  try {
    await ElMessageBox.confirm(
      '将丢弃尚未保存的认证、模型、绑定和密钥修改。',
      '放弃未保存修改？',
      { type: 'warning', confirmButtonText: '放弃修改', cancelButtonText: '继续编辑' },
    );
  } catch {
    return;
  }
  await load();
}

async function save(): Promise<void> {
  if (
    !saved.value
    || !draft.value
    || !hasUnsavedChanges.value
    || saving.value
    || runtime.restartInProgress
  ) return;
  saving.value = true;
  try {
    const input = buildModelConfigPutInput(saved.value, draft.value, secretDrafts);
    const aggregate = await api('/models', modelAdminAggregateSchema, {
      method: 'PUT',
      body: jsonBody(modelConfigPutSchema, input),
    });
    hydrate(aggregate);
    await refreshRuntimeOverview();
    ElMessage.success('模型配置已保存，可从右上角重启使其生效。');
  } catch (error) {
    if (isStaleRevisionConflict(error)) {
      try {
        await ElMessageBox.confirm(
          '服务端 revision 已变化。重新载入会丢弃当前草稿，避免覆盖其他管理员的修改。',
          '配置冲突',
          { type: 'warning', confirmButtonText: '重新载入', cancelButtonText: '保留草稿' },
        );
        await load();
      } catch {
        ElMessage.warning('当前草稿已保留，请核对服务端变更后再保存。');
      }
      return;
    }
    ElMessage.error(errorMessage(error, '模型配置保存失败'));
  } finally {
    saving.value = false;
  }
}

function isStaleRevisionConflict(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  if (!error.details || typeof error.details !== 'object' || Array.isArray(error.details)) {
    return false;
  }
  const details = error.details as Record<string, unknown>;
  return details.modelConfigErrorCode === 'revision_conflict'
    && typeof details.expectedRevision === 'number'
    && typeof details.actualRevision === 'number'
    && details.expectedRevision !== details.actualRevision;
}

function connectionAuthState(connectionId: string): ModelConnectionAuthState | null {
  return saved.value?.connectionStates.find((state) => state.connectionId === connectionId) ?? null;
}

function secretFor(connectionId: string): SecretDraft {
  const existing = secretDrafts[connectionId];
  if (existing) return existing;
  const created: SecretDraft = { operation: 'clear', value: '' };
  secretDrafts[connectionId] = created;
  return created;
}

function manualAuthKind(connection: ConnectionDraft): ManualAuthKind {
  return connection.auth.kind === 'apiKey' ? 'apiKey' : 'none';
}

function setManualAuthKind(connection: ConnectionDraft, value: unknown): void {
  if (value === 'apiKey') {
    connection.auth = {
      kind: 'apiKey',
      secretRef: `${connection.id}.api-key`,
    };
    if (!secretDrafts[connection.id]) {
      secretDrafts[connection.id] = { operation: 'set', value: '' };
    }
    return;
  }
  connection.auth = { kind: 'none' };
  delete secretDrafts[connection.id];
}

function setConnectionAdapter(connection: ConnectionDraft, value: unknown): void {
  if (saved.value?.connections.some((item) => item.id === connection.id)) {
    ElMessage.warning('已保存 connection 的 adapter 不可修改；请创建新的 canonical connection。');
    return;
  }
  if (draft.value?.models.some((model) => model.connectionId === connection.id)) {
    ElMessage.warning('请先删除该 connection 下的模型档案，再修改 adapter。');
    return;
  }
  if (!['openaiCompatible', 'codexBridge', 'copilotBridge'].includes(String(value))) return;
  const adapter = value as AdapterType;
  connection.adapter = adapter;
  if (adapter === 'openaiCompatible') {
    connection.baseUrl = '';
    connection.auth = { kind: 'none' };
    connection.catalogDriver = 'openaiModels';
    delete secretDrafts[connection.id];
    return;
  }
  connection.baseUrl = null;
  connection.auth = {
    kind: 'oauth',
    provider: adapter === 'codexBridge' ? 'codex' : 'copilot',
  };
  connection.catalogDriver = adapter === 'codexBridge' ? 'codexBridge' : 'copilotBridge';
  delete secretDrafts[connection.id];
}

function createConnectionDraft(): void {
  if (!draft.value) return;
  const id = createConnection.id.trim();
  const displayName = createConnection.displayName.trim();
  if (!connectionIdSchema.safeParse(id).success) {
    ElMessage.error('Connection ID 只能使用小写字母、数字和短横线。');
    return;
  }
  if (!displayName) {
    ElMessage.error('显示名称不能为空。');
    return;
  }
  if (draft.value.connections.some((connection) => connection.id === id)) {
    ElMessage.error(`Connection ID ${id} 已存在。`);
    return;
  }
  const adapter = createConnection.adapter;
  if (adapter === 'openaiCompatible' && !createConnection.baseUrl.trim()) {
    ElMessage.error('OpenAI-compatible connection 需要明确填写 Base URL。');
    return;
  }
  const connection: ConnectionDraft = adapter === 'openaiCompatible'
    ? {
        id,
        displayName,
        adapter,
        baseUrl: createConnection.baseUrl.trim(),
        auth: { kind: 'apiKey', secretRef: `${id}.api-key` },
        catalogDriver: 'openaiModels',
      }
    : {
        id,
        displayName,
        adapter,
        baseUrl: null,
        auth: {
          kind: 'oauth',
          provider: adapter === 'codexBridge' ? 'codex' : 'copilot',
        },
        catalogDriver: adapter === 'codexBridge' ? 'codexBridge' : 'copilotBridge',
      };
  draft.value.connections.push(connection);
  if (connection.auth.kind === 'apiKey') {
    secretDrafts[id] = { operation: 'set', value: '' };
  }
  selectedConnectionId.value = id;
  createConnectionOpen.value = false;
  Object.assign(createConnection, {
    id: '',
    displayName: '',
    adapter: 'openaiCompatible',
    baseUrl: '',
  });
}

async function removeSelectedConnection(): Promise<void> {
  const connection = selectedConnection.value;
  if (!connection || !draft.value) return;
  const bindings = draft.value.bindings.filter(
    (binding) => binding.mode === 'dedicated' && binding.connectionId === connection.id,
  );
  if (bindings.length > 0) {
    ElMessage.error(`请先调整 ${bindings.length} 个正在使用 ${connection.displayName} 的模型设置。`);
    return;
  }
  const models = draft.value.models.filter((model) => model.connectionId === connection.id);
  if (connection.catalogDriver === 'static' && models.length > 0) {
    ElMessage.error(`请先删除 ${models.length} 个属于 ${connection.displayName} 的模型档案。`);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `删除 connection ${connection.displayName}（${connection.id}）？`,
      '删除接口连接',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  draft.value.connections = draft.value.connections.filter((item) => item.id !== connection.id);
  draft.value.models = draft.value.models.filter((model) => model.connectionId !== connection.id);
  delete secretDrafts[connection.id];
  delete catalogByConnection[connection.id];
  selectedConnectionId.value = draft.value.connections[0]?.id ?? '';
}

async function addStaticModelProfile(): Promise<void> {
  if (!draft.value || !selectedConnection.value) return;
  try {
    const result = await ElMessageBox.prompt(
      '输入当前 connection 内唯一的 canonical model ID。创建后可在下方完整编辑 transport contract。',
      '新增模型档案',
      {
        confirmButtonText: '新增',
        cancelButtonText: '取消',
        inputPlaceholder: '例如 openai-gpt-5',
        inputPattern: /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
        inputErrorMessage: 'Model ID 只能使用小写字母、数字、点、下划线和短横线。',
      },
    );
    const id = result.value.trim();
    if (!modelIdSchema.safeParse(id).success) {
      ElMessage.error('Model ID 不符合 canonical ID 约束。');
      return;
    }
    if (draft.value.models.some((model) => (
      model.connectionId === selectedConnection.value?.id && model.id === id
    ))) {
      ElMessage.error(`当前 connection 已存在 Model ID ${id}。`);
      return;
    }
    draft.value.models.push({
      id,
      connectionId: selectedConnection.value.id,
      displayName: id,
      transportModel: '',
      contextSize: 128_000,
      requestMode: selectedConnection.value.adapter === 'codexBridge'
        ? 'responses'
        : 'chat_completions',
      structuredOutputProtocol: null,
      capabilities: {
        vision: false,
        tools: false,
        structuredOutput: false,
      },
      timeoutMs: 180_000,
      requestDefaults: {},
    });
  } catch {
    // Dialog cancelled.
  }
}

const CATALOG_CHOICE_PREFIX = '__catalog__:';

function catalogChoiceValue(transportModel: string): string {
  return `${CATALOG_CHOICE_PREFIX}${transportModel}`;
}

function pruneUnusedCatalogModels(): void {
  if (!draft.value) return;
  draft.value.models = trimUnreferencedCatalogModels(draft.value).models;
}

function catalogProfile(
  connection: ConnectionDraft,
  entry: ModelCatalogEntry,
): ModelProfileDraft {
  const existing = draft.value?.models.find((model) => (
    model.connectionId === connection.id
    && model.transportModel === entry.transportModel
  ));
  if (existing) return existing;
  return createCatalogModelProfile({
    connection,
    entry,
    existingIds: draft.value?.models
      .filter((model) => model.connectionId === connection.id)
      .map((model) => model.id) ?? [],
  });
}

function modelConnectionAdapter(model: ModelProfileDraft): AdapterType | null {
  return draft.value?.connections.find(
    (connection) => connection.id === model.connectionId,
  )?.adapter ?? null;
}

function applyModelContractCandidate(
  model: ModelProfileDraft,
  candidate: ModelProfileDraft,
): boolean {
  if (!draft.value) return false;
  const incompatible = incompatibleWorkloadsForModel(draft.value, candidate);
  if (incompatible.length > 0) {
    ElMessage.error(`该修改会破坏用途绑定：${incompatible.join('、')}。请先调整绑定。`);
    return false;
  }
  Object.assign(model, candidate);
  return true;
}

function setRequestMode(model: ModelProfileDraft, value: unknown): void {
  if (value !== 'chat_completions' && value !== 'responses') return;
  if (modelConnectionAdapter(model) === 'codexBridge' && value !== 'responses') {
    ElMessage.warning('Codex bridge 只支持 responses request mode。');
    return;
  }
  applyModelContractCandidate(model, withModelRequestMode(model, value));
}

function structuredOutputOptions(model: ModelProfileDraft) {
  return structuredOutputProtocolsForRequestMode(model.requestMode);
}

function setStructuredOutput(model: ModelProfileDraft, value: unknown): void {
  const protocol = value === null || value === ''
    ? null
    : String(value) as ModelProfileDraft['structuredOutputProtocol'];
  try {
    applyModelContractCandidate(model, withStructuredOutputProtocol(model, protocol));
  } catch (error) {
    ElMessage.error(errorMessage(error, 'Structured output protocol 无效'));
  }
}

function setModelCapability(
  model: ModelProfileDraft,
  capability: 'vision' | 'tools',
  value: unknown,
): void {
  if (typeof value !== 'boolean') return;
  applyModelContractCandidate(model, {
    ...model,
    capabilities: {
      ...model.capabilities,
      [capability]: value,
    },
    requestDefaults: { ...model.requestDefaults },
  });
}

async function removeModelProfile(model: ModelProfileDraft): Promise<void> {
  if (!draft.value) return;
  const references = draft.value.bindings.filter(
    (binding) => (
      binding.mode === 'dedicated'
      && binding.connectionId === model.connectionId
      && binding.modelId === model.id
    ),
  );
  if (references.length > 0) {
    ElMessage.error(`模型仍被 ${references.map((binding) => binding.workload).join('、')} 引用。`);
    return;
  }
  try {
    await ElMessageBox.confirm(`删除模型档案 ${model.displayName}（${model.id}）？`, '删除模型档案', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  draft.value.models = draft.value.models.filter((item) => (
    item.connectionId !== model.connectionId || item.id !== model.id
  ));
}

function bindingMeta(workload: string): {
  label: string;
} {
  return WORKLOAD_DETAILS[workload] ?? {
    label: workload.replace(/^agent\.subagent\./, 'Agent · '),
  };
}

function setBindingMode(index: number, value: unknown): void {
  if (!draft.value) return;
  const binding = draft.value.bindings[index];
  if (!binding || !['dedicated', 'disabled', 'inheritMain', 'inheritInvocation'].includes(String(value))) return;
  try {
    draft.value.bindings[index] = replaceBindingMode(binding, value as BindingMode);
    pruneUnusedCatalogModels();
  } catch (error) {
    ElMessage.error(errorMessage(error, '绑定模式无效'));
  }
}

function setBindingConnection(binding: BindingDraft, value: unknown): void {
  if (binding.mode !== 'dedicated') return;
  binding.connectionId = String(value);
  binding.modelId = '';
  pruneUnusedCatalogModels();
  void ensureCatalog(binding.connectionId, false);
}

function compatibleConnections(binding: BindingDraft): ConnectionDraft[] {
  if (!draft.value || binding.mode !== 'dedicated') return [];
  const compatibleIds = compatibleConnectionIds(draft.value, binding.workload);
  return draft.value.connections.filter((connection) => (
    connectionConfigured(connection.id)
    && (
      connection.catalogDriver !== 'static'
      || compatibleIds.has(connection.id)
    )
  ));
}

function compatibleModelChoices(binding: BindingDraft): ModelChoice[] {
  if (!draft.value || binding.mode !== 'dedicated' || !binding.connectionId) return [];
  const connection = draft.value.connections.find(
    (item) => item.id === binding.connectionId,
  );
  if (!connection) return [];
  const existing = draft.value.models.filter((model) => (
    model.connectionId === binding.connectionId
    && isModelCompatible(binding.workload, model)
  ));
  const choices = new Map<string, ModelChoice>();
  for (const model of existing) {
    choices.set(model.transportModel, {
      key: `model:${model.id}`,
      value: model.id,
      label: model.displayName,
    });
  }
  if (connection.catalogDriver === 'static') return [...choices.values()];
  for (const entry of catalogByConnection[connection.id]?.models ?? []) {
    const profile = catalogProfile(connection, entry);
    if (!isModelCompatible(binding.workload, profile)) continue;
    const savedProfile = existing.find(
      (model) => model.transportModel === entry.transportModel,
    );
    choices.set(entry.transportModel, {
      key: `catalog:${entry.transportModel}`,
      value: savedProfile?.id ?? catalogChoiceValue(entry.transportModel),
      label: entry.displayName,
    });
  }
  return [...choices.values()];
}

function setBindingModel(binding: BindingDraft, value: unknown): void {
  if (!draft.value || binding.mode !== 'dedicated') return;
  const selection = String(value);
  if (!selection.startsWith(CATALOG_CHOICE_PREFIX)) {
    binding.modelId = selection;
    pruneUnusedCatalogModels();
    return;
  }
  const connection = draft.value.connections.find(
    (item) => item.id === binding.connectionId,
  );
  const transportModel = selection.slice(CATALOG_CHOICE_PREFIX.length);
  const entry = catalogByConnection[binding.connectionId]?.models.find(
    (item) => item.transportModel === transportModel,
  );
  if (!connection || !entry) {
    ElMessage.error('模型目录已变化，请重新打开模型选择。');
    return;
  }
  try {
    const profile = catalogProfile(connection, entry);
    if (!isModelCompatible(binding.workload, profile)) {
      ElMessage.error('该模型不满足当前用途。');
      return;
    }
    if (!draft.value.models.some((model) => (
      model.connectionId === profile.connectionId
      && model.id === profile.id
    ))) {
      draft.value.models.push(profile);
    }
    binding.modelId = profile.id;
    pruneUnusedCatalogModels();
  } catch (error) {
    ElMessage.error(errorMessage(error, '模型选择失败'));
  }
}

function handleModelSelectVisibility(binding: BindingDraft, visible: boolean): void {
  if (!visible || binding.mode !== 'dedicated') return;
  void ensureCatalog(binding.connectionId, false);
}

async function addAgentOverride(): Promise<void> {
  if (!draft.value) return;
  try {
    const result = await ElMessageBox.prompt(
      '输入运行时使用的完整 Agent canonical ID（例如 builtin:plan、preset:researcher）。ID 会原样保存，不会改名或归一化；模型仅在此统一配置页维护。',
      '新增 Agent 模型 override',
      {
        confirmButtonText: '新增',
        cancelButtonText: '取消',
        inputPlaceholder: 'builtin:plan',
        inputPattern: /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/,
        inputErrorMessage: '请输入完整 canonical Agent ID；可使用小写字母、数字、点、下划线、冒号和短横线。',
      },
    );
    const workload = `agent.subagent.${result.value.trim()}`;
    if (workload === 'agent.subagent.default'
      || draft.value.bindings.some((binding) => binding.workload === workload)) {
      ElMessage.error(`${workload} 已存在。`);
      return;
    }
    draft.value.bindings.push({ workload, mode: 'inheritInvocation' });
  } catch {
    // Dialog cancelled.
  }
}

async function removeAgentOverride(index: number): Promise<void> {
  const binding = draft.value?.bindings[index];
  if (!binding || WORKLOAD_DETAILS[binding.workload]) return;
  try {
    await ElMessageBox.confirm(`删除 ${binding.workload} 的模型 override？`, '删除 Agent override', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  draft.value?.bindings.splice(index, 1);
  pruneUnusedCatalogModels();
}

async function probeConnection(connectionId: string): Promise<void> {
  if (operationBusy.value) return;
  operationBusy.value = `probe:${connectionId}`;
  try {
    const result = await api(
      `/models/connections/${encodeURIComponent(connectionId)}/probe`,
      modelConnectionProbeResponseSchema,
      { method: 'POST', body: jsonBody(emptyRequestSchema, {}) },
    );
    probeByConnection[connectionId] = {
      checkedAt: result.checkedAt,
      latencyMs: result.latencyMs,
    };
    ElMessage.success(`连接探测成功，${result.latencyMs} ms。`);
  } catch (error) {
    ElMessage.error(errorMessage(error, '连接探测失败'));
  } finally {
    operationBusy.value = null;
  }
}

async function refreshCatalog(
  connectionId: string,
  notify = true,
): Promise<ModelCatalogResponse | null> {
  if (operationBusy.value) return null;
  operationBusy.value = `catalog:${connectionId}`;
  try {
    const result = await api(
      `/models/connections/${encodeURIComponent(connectionId)}/catalog`,
      modelCatalogResponseSchema,
      { method: 'POST', body: jsonBody(emptyRequestSchema, {}) },
    );
    catalogByConnection[connectionId] = result;
    if (notify) ElMessage.success('模型目录已刷新');
    return result;
  } catch (error) {
    if (notify) ElMessage.error(errorMessage(error, '模型目录刷新失败'));
    return null;
  } finally {
    operationBusy.value = null;
  }
}

async function ensureCatalog(connectionId: string, notify: boolean): Promise<void> {
  if (!draft.value || catalogByConnection[connectionId]) return;
  const connection = draft.value.connections.find((item) => item.id === connectionId);
  if (
    !connection
    || !saved.value
    || connection.catalogDriver === 'static'
    || !isSavedConnectionOperationTarget(
      saved.value,
      draft.value,
      secretDrafts,
      connectionId,
    )
  ) {
    return;
  }
  await refreshCatalog(connectionId, notify);
}

async function oauth(connectionId: string, action: 'start' | 'poll' | 'logout'): Promise<void> {
  if (operationBusy.value) return;
  const state = connectionAuthState(connectionId);
  operationBusy.value = `oauth:${connectionId}:${action}`;
  try {
    const body = action === 'poll'
      ? jsonBody(modelOAuthPollRequestSchema, { attemptId: state?.attempt?.attemptId })
      : jsonBody(emptyRequestSchema, {});
    const result = await api(
      `/models/connections/${encodeURIComponent(connectionId)}/oauth/${action}`,
      modelConnectionAuthStateSchema,
      { method: 'POST', body },
    );
    if (saved.value) {
      const index = saved.value.connectionStates.findIndex((item) => item.connectionId === connectionId);
      if (index >= 0) saved.value.connectionStates[index] = result;
      else saved.value.connectionStates.push(result);
    }
    ElMessage.success(action === 'start' ? 'OAuth 登录已启动。' : action === 'logout' ? 'OAuth 已退出。' : 'OAuth 状态已更新。');
  } catch (error) {
    ElMessage.error(errorMessage(error, 'OAuth 操作失败'));
  } finally {
    operationBusy.value = null;
  }
}

function copyOAuthCode(): void {
  const code = selectedAuthState.value?.attempt?.userCode;
  if (!code) return;
  void navigator.clipboard.writeText(code)
    .then(() => ElMessage.success('设备码已复制'))
    .catch(() => ElMessage.error('设备码复制失败，请手动复制。'));
}

function openOAuthVerification(): void {
  const url = selectedAuthState.value?.attempt?.verificationUri;
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedChanges.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onBeforeRouteLeave(async () => {
  if (!hasUnsavedChanges.value) return true;
  try {
    await ElMessageBox.confirm(
      '当前模型配置草稿尚未保存，离开页面会丢失这些修改。',
      '离开模型配置？',
      { type: 'warning', confirmButtonText: '放弃并离开', cancelButtonText: '继续编辑' },
    );
    return true;
  } catch {
    return false;
  }
});

function handleSave(): void {
  void save();
}

function refreshPageWhenVisible(): void {
  if (
    document.visibilityState === 'visible'
    && !hasUnsavedChanges.value
    && !saving.value
    && !runtime.restartInProgress
  ) {
    void load();
  }
}

watch(
  [selectedConnectionId, canOperateSelectedConnection],
  ([connectionId, canOperate]) => {
    if (connectionId && canOperate) void ensureCatalog(connectionId, false);
  },
  { flush: 'post' },
);
watch(
  () => runtime.restartGeneration,
  () => {
    if (!hasUnsavedChanges.value) void load();
  },
);

onMounted(() => {
  void load();
  window.addEventListener('admin-save', handleSave);
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('focus', refreshPageWhenVisible);
  document.addEventListener('visibilitychange', refreshPageWhenVisible);
});
onBeforeUnmount(() => {
  window.removeEventListener('admin-save', handleSave);
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('focus', refreshPageWhenVisible);
  document.removeEventListener('visibilitychange', refreshPageWhenVisible);
});
</script>

<template>
  <section v-if="modelLoadError" class="panel load-error">
    <div><strong>模型配置加载失败</strong><p>{{ modelLoadError }}</p></div>
    <el-button type="primary" plain :loading="loading" @click="load">重试加载</el-button>
  </section>

  <section v-else-if="loading && (!saved || !draft)" class="panel model-loading" role="status">
    <el-skeleton :rows="8" animated />
  </section>

  <template v-if="saved && draft">
    <section class="panel connections-panel">
      <div class="panel-head">
        <div>
          <h2>认证与模型列表</h2>
        </div>
        <el-button type="primary" plain size="small" @click="createConnectionOpen = true">新增认证</el-button>
      </div>
      <div class="connections-layout">
        <aside class="connection-list">
          <el-input
            v-model="connectionQuery"
            clearable
            placeholder="搜索认证配置"
            aria-label="搜索认证配置"
          />
          <button
            v-for="connection in filteredConnections"
            :key="connection.id"
            :class="[
              {
                active: connection.id === selectedConnectionId,
                'is-configured': connectionConfigured(connection.id),
                'needs-configuration': !connectionConfigured(connection.id),
              },
            ]"
            :aria-label="`${connection.displayName}，${connectionConfigured(connection.id) ? '配置良好' : '需要配置'}`"
            @click="selectedConnectionId = connection.id"
          >
            <span
              class="provider-mark"
              :class="`provider-${connectionBrand(connection).tone}`"
              aria-hidden="true"
            >
              <img :src="connectionBrand(connection).icon" alt="" />
            </span>
            <span class="connection-name">
              <strong>{{ connection.displayName }}</strong>
            </span>
          </button>
        </aside>

        <div v-if="selectedConnection" class="connection-editor">
          <div class="editor-title">
            <div>
              <h3>{{ selectedConnection.displayName }}</h3>
            </div>
            <div>
              <el-button
                :loading="operationBusy === `probe:${selectedConnection.id}`"
                :disabled="!canOperateSelectedConnection"
                @click="probeConnection(selectedConnection.id)"
              >
                探测连接
              </el-button>
              <el-button
                v-if="selectedConnection.catalogDriver !== 'static'"
                :loading="operationBusy === `catalog:${selectedConnection.id}`"
                :disabled="!canOperateSelectedConnection"
                @click="refreshCatalog(selectedConnection.id)"
              >
                刷新目录
              </el-button>
              <el-button type="danger" plain @click="removeSelectedConnection">删除认证</el-button>
            </div>
          </div>

          <div v-if="probeByConnection[selectedConnection.id]" class="probe-result">
            最近探测：
            {{ probeByConnection[selectedConnection.id]?.latencyMs }} ms ·
            {{ new Date(probeByConnection[selectedConnection.id]?.checkedAt || '').toLocaleString() }}
          </div>
          <el-alert
            v-if="savedConnection && !canOperateSelectedConnection"
            type="warning"
            :closable="false"
            show-icon
            title="请先保存或放弃当前认证及凭据修改，再执行连接操作。"
          />

          <el-form label-position="top" class="connection-form">
            <el-form-item label="配置 ID">
              <el-input :model-value="selectedConnection.id" disabled />
            </el-form-item>
            <el-form-item label="显示名称">
              <el-input v-model="selectedConnection.displayName" />
            </el-form-item>
            <el-form-item label="Adapter">
              <el-select
                :model-value="selectedConnection.adapter"
                :disabled="savedConnection !== null"
                style="width:100%"
                @change="setConnectionAdapter(selectedConnection, $event)"
              >
                <el-option value="openaiCompatible" label="OpenAI compatible" />
                <el-option value="codexBridge" label="Codex bridge" />
                <el-option value="copilotBridge" label="Copilot bridge" />
              </el-select>
            </el-form-item>
            <el-form-item label="Catalog driver">
              <el-select v-model="selectedConnection.catalogDriver" style="width:100%" :disabled="selectedConnection.adapter !== 'openaiCompatible'">
                <el-option value="static" label="Static · 手工档案" />
                <el-option value="openaiModels" label="OpenAI /models" />
                <el-option v-if="selectedConnection.adapter === 'codexBridge'" value="codexBridge" label="Codex bridge" />
                <el-option v-if="selectedConnection.adapter === 'copilotBridge'" value="copilotBridge" label="Copilot bridge" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="selectedConnection.adapter === 'openaiCompatible'" label="Base URL" class="span-2">
              <el-input v-model="selectedConnection.baseUrl" placeholder="https://provider.example.com/v1" />
            </el-form-item>
            <el-form-item v-if="selectedConnection.adapter === 'openaiCompatible'" label="Authentication">
              <el-segmented
                :model-value="manualAuthKind(selectedConnection)"
                :options="[{ label: '无需认证', value: 'none' }, { label: 'API key', value: 'apiKey' }]"
                @change="setManualAuthKind(selectedConnection, $event)"
              />
            </el-form-item>
            <el-form-item v-if="selectedConnection.auth.kind === 'apiKey'" label="Secret reference">
              <el-input v-model="selectedConnection.auth.secretRef" />
            </el-form-item>
          </el-form>

          <section v-if="selectedConnection.auth.kind === 'apiKey'" class="secret-card">
            <div class="secret-title">
              <strong>API key</strong>
              <el-tag size="small" :type="savedConnection?.credentialState === 'configured' ? 'success' : 'danger'">
                {{ savedConnection?.credentialState === 'configured' ? '已配置' : '缺失' }}
              </el-tag>
            </div>
            <el-radio-group v-model="secretFor(selectedConnection.id).operation">
              <el-radio-button value="retain">保持</el-radio-button>
              <el-radio-button value="set">设置新值</el-radio-button>
              <el-radio-button value="clear">清空</el-radio-button>
            </el-radio-group>
            <el-input
              v-if="secretFor(selectedConnection.id).operation === 'set'"
              v-model="secretFor(selectedConnection.id).value"
              type="password"
              show-password
              placeholder="输入新的 API key"
            />
          </section>

          <section v-if="selectedConnection.auth.kind === 'oauth'" class="oauth-card">
            <div class="oauth-title">
              <strong>{{ selectedConnection.auth.provider }} OAuth</strong>
              <el-tag size="small" :type="selectedAuthState?.status === 'ready' ? 'success' : 'info'">
                {{ selectedAuthState?.accountLabel || selectedAuthState?.error || selectedAuthState?.status || '未读取' }}
              </el-tag>
            </div>
            <div class="oauth-actions">
              <el-button
                v-if="selectedAuthState?.status !== 'ready'"
                :loading="operationBusy === `oauth:${selectedConnection.id}:start`"
                :disabled="!canOperateSelectedConnection"
                @click="oauth(selectedConnection.id, 'start')"
              >
                启动登录
              </el-button>
              <el-button
                v-if="selectedAuthState?.status === 'ready'"
                type="danger"
                plain
                :loading="operationBusy === `oauth:${selectedConnection.id}:logout`"
                :disabled="!canOperateSelectedConnection"
                @click="oauth(selectedConnection.id, 'logout')"
              >
                退出 OAuth
              </el-button>
            </div>
            <div v-if="selectedAuthState?.attempt" class="oauth-attempt">
              <code>{{ selectedAuthState.attempt.userCode }}</code>
              <el-button text @click="copyOAuthCode">复制</el-button>
              <el-button @click="openOAuthVerification">打开验证页</el-button>
              <el-button
                type="primary"
                :loading="operationBusy === `oauth:${selectedConnection.id}:poll`"
                :disabled="!canOperateSelectedConnection"
                @click="oauth(selectedConnection.id, 'poll')"
              >
                检查状态
              </el-button>
            </div>
          </section>

          <section
            v-if="selectedConnection.catalogDriver === 'static'"
            class="models-section"
          >
            <div class="subsection-title">
              <div>
                <h4>手动模型</h4>
              </div>
              <el-button
                size="small"
                @click="addStaticModelProfile"
              >
                新增模型
              </el-button>
            </div>
            <el-collapse>
              <el-collapse-item
                v-for="model in selectedConnectionModels"
                :key="model.id"
                :name="model.id"
              >
                <template #title>
                  <div class="model-title">
                    <strong>{{ model.displayName }}</strong>
                  </div>
                </template>
                <el-form label-position="top" class="model-form">
                  <el-form-item label="模型 ID">
                    <el-input :model-value="model.id" disabled />
                  </el-form-item>
                  <el-form-item label="显示名称">
                    <el-input v-model="model.displayName" />
                  </el-form-item>
                  <el-form-item label="Provider 模型名">
                    <el-input v-model="model.transportModel" />
                  </el-form-item>
                  <el-form-item label="上下文长度">
                    <el-input-number v-model="model.contextSize" :min="1" :controls="false" style="width:100%" />
                  </el-form-item>
                  <el-form-item label="超时（ms）">
                    <el-input-number v-model="model.timeoutMs" :min="1000" :max="600000" :controls="false" style="width:100%" />
                  </el-form-item>
                  <el-form-item label="请求模式">
                    <el-select
                      :model-value="model.requestMode"
                      :disabled="modelConnectionAdapter(model) === 'codexBridge'"
                      style="width:100%"
                      @change="setRequestMode(model, $event)"
                    >
                      <el-option
                        v-if="modelConnectionAdapter(model) !== 'codexBridge'"
                        value="chat_completions"
                        label="chat_completions"
                      />
                      <el-option value="responses" label="responses" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="结构化输出">
                    <el-select
                      :model-value="model.structuredOutputProtocol"
                      clearable
                      placeholder="无"
                      style="width:100%"
                      @change="setStructuredOutput(model, $event)"
                    >
                      <el-option
                        v-for="protocol in structuredOutputOptions(model)"
                        :key="protocol"
                        :value="protocol"
                        :label="protocol"
                      />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="能力" class="span-2">
                    <el-checkbox
                      :model-value="model.capabilities.vision"
                      @change="setModelCapability(model, 'vision', $event)"
                    >
                      Vision
                    </el-checkbox>
                    <el-checkbox
                      :model-value="model.capabilities.tools"
                      @change="setModelCapability(model, 'tools', $event)"
                    >
                      Tools
                    </el-checkbox>
                    <el-checkbox :model-value="model.capabilities.structuredOutput" disabled>Structured output</el-checkbox>
                  </el-form-item>
                  <el-form-item label="Temperature">
                    <el-input-number v-model="model.requestDefaults.temperature" :min="0" :max="2" :step="0.1" :controls="false" style="width:100%" />
                  </el-form-item>
                  <el-form-item label="Top P">
                    <el-input-number v-model="model.requestDefaults.topP" :min="0.01" :max="1" :step="0.05" :controls="false" style="width:100%" />
                  </el-form-item>
                  <el-form-item label="Max output tokens">
                    <el-input-number v-model="model.requestDefaults.maxOutputTokens" :min="1" :controls="false" style="width:100%" />
                  </el-form-item>
                  <el-form-item label="Reasoning effort">
                    <el-select v-model="model.requestDefaults.reasoningEffort" clearable style="width:100%">
                      <el-option v-for="effort in ['none','minimal','low','medium','high','xhigh']" :key="effort" :value="effort" :label="effort" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="Thinking mode">
                    <el-select v-model="model.requestDefaults.thinkingMode" clearable style="width:100%">
                      <el-option value="enabled" label="enabled" />
                      <el-option value="disabled" label="disabled" />
                    </el-select>
                  </el-form-item>
                  <el-form-item class="remove-model">
                    <el-button type="danger" plain @click="removeModelProfile(model)">删除模型档案</el-button>
                  </el-form-item>
                </el-form>
              </el-collapse-item>
            </el-collapse>
          </section>
        </div>
      </div>
    </section>

    <section class="panel binding-panel">
      <div class="panel-head">
        <div>
          <h2>模型设置</h2>
        </div>
        <el-button size="small" @click="addAgentOverride">新增 Agent 设置</el-button>
      </div>
      <div class="binding-list">
        <article
          v-for="{ binding, sourceIndex } in orderedBindings"
          :key="binding.workload"
          class="binding-row"
          :class="{ 'binding-target': binding.workload === requestedWorkload }"
          :data-workload="binding.workload"
        >
          <div class="binding-purpose">
            <strong>{{ bindingMeta(binding.workload).label }}</strong>
          </div>
          <div class="binding-controls">
            <div class="binding-control">
              <span>使用方式</span>
              <el-select
                :model-value="binding.mode"
                aria-label="使用方式"
                @change="setBindingMode(sourceIndex, $event)"
              >
                <el-option
                  v-for="mode in allowedBindingModes(binding.workload)"
                  :key="mode"
                  :value="mode"
                  :label="MODE_LABELS[mode]"
                />
              </el-select>
            </div>
            <template v-if="binding.mode === 'dedicated'">
              <div class="binding-control">
                <span>认证配置</span>
                <el-select
                  :model-value="binding.connectionId"
                  filterable
                  placeholder="选择认证配置"
                  aria-label="认证配置"
                  @change="setBindingConnection(binding, $event)"
                >
                  <el-option
                    v-for="connection in compatibleConnections(binding)"
                    :key="connection.id"
                    :value="connection.id"
                    :label="connection.displayName"
                  />
                </el-select>
              </div>
              <div class="binding-control">
                <span>模型</span>
                <el-select
                  :model-value="binding.modelId"
                  filterable
                  placeholder="选择兼容模型"
                  aria-label="模型"
                  :loading="operationBusy === `catalog:${binding.connectionId}`"
                  @change="setBindingModel(binding, $event)"
                  @visible-change="handleModelSelectVisibility(binding, $event)"
                >
                  <el-option
                    v-for="choice in compatibleModelChoices(binding)"
                    :key="choice.key"
                    :value="choice.value"
                    :label="choice.label"
                  />
                </el-select>
              </div>
            </template>
          </div>
          <el-button
            v-if="!WORKLOAD_DETAILS[binding.workload]"
            class="remove-binding"
            text
            type="danger"
            @click="removeAgentOverride(sourceIndex)"
          >
            删除
          </el-button>
        </article>
      </div>
    </section>

    <PendingChangesBar
      v-if="hasUnsavedChanges"
      :saving="saving"
      :disabled="runtime.restartInProgress"
      @discard="discardChanges"
      @save="save"
    />
  </template>

  <el-dialog v-model="createConnectionOpen" title="新增认证配置" width="min(520px, 92vw)">
    <el-form label-position="top">
      <el-form-item label="配置 ID">
        <el-input v-model="createConnection.id" placeholder="provider-cn" />
      </el-form-item>
      <el-form-item label="显示名称">
        <el-input v-model="createConnection.displayName" />
      </el-form-item>
      <el-form-item label="Adapter">
        <el-select v-model="createConnection.adapter" style="width:100%">
          <el-option value="openaiCompatible" label="OpenAI compatible" />
          <el-option value="codexBridge" label="Codex bridge" />
          <el-option value="copilotBridge" label="Copilot bridge" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="createConnection.adapter === 'openaiCompatible'" label="Base URL">
        <el-input v-model="createConnection.baseUrl" placeholder="https://provider.example.com/v1" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="createConnectionOpen = false">取消</el-button>
      <el-button type="primary" @click="createConnectionDraft">创建认证草稿</el-button>
    </template>
  </el-dialog>

</template>

<style scoped>
.load-error{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 20px;color:#923b3b;background:#fff5f5}.load-error strong{font-size:13px}.load-error p{margin:4px 0 0;font-size:10px}.binding-panel,.connections-panel{margin-bottom:16px;overflow:hidden}.binding-list{display:grid}.binding-row{position:relative;display:grid;grid-template-columns:minmax(220px,.75fr) minmax(0,2fr);gap:24px;align-items:center;padding:15px 18px;border-top:1px solid var(--line)}.binding-row.binding-target{background:#f2f6ff;box-shadow:inset 3px 0 #416de0}.binding-row:first-child{border-top:0}.binding-purpose{min-width:0}.binding-purpose strong{display:block;color:#344056;font-size:12px}.binding-controls{display:grid;grid-template-columns:minmax(130px,.75fr) minmax(160px,1fr) minmax(180px,1.3fr);gap:8px}.binding-control{min-width:0}.binding-control>span{display:block;margin:0 0 5px;color:#8a94a3;font-size:9px}.binding-control>.el-select{width:100%}.binding-control:first-child:last-child{grid-column:1/-1}.remove-binding{position:absolute;right:8px;top:4px}.connections-layout{height:500px;display:grid;grid-template-columns:260px minmax(0,1fr)}.connection-list{min-height:0;overflow-y:auto;padding:12px;border-right:1px solid var(--line);background:#fbfcfe}.connection-list>.el-input{margin-bottom:10px}.connection-list>button{width:100%;display:flex;align-items:center;justify-content:flex-start;gap:10px;margin:3px 0;padding:9px 10px;border:1px solid transparent;border-radius:9px;text-align:left;transition:background .16s ease,border-color .16s ease,box-shadow .16s ease}.connection-list>button.is-configured{background:#f0faf4}.connection-list>button.needs-configuration{background:#fff2f1}.connection-list>button.is-configured:hover{background:#e7f7ed}.connection-list>button.needs-configuration:hover{background:#ffe9e7}.connection-list>button.active{border-color:#9fb7f0;box-shadow:inset 3px 0 #416de0}.provider-mark{width:30px;height:30px;display:grid;flex:none;place-items:center;border-radius:9px}.provider-mark img{width:19px;height:19px;object-fit:contain}.provider-openai{color:#087f6f;background:#dff6ef}.provider-copilot{color:#533c9d;background:#eee9ff}.provider-deepseek{background:#e9f0ff}.provider-siliconflow{background:#eee8ff}.provider-volcengine{background:#e8fbfb}.provider-xiaomi{color:#f56600;background:#fff0e5}.connection-name{min-width:0}.connection-list strong{display:block;overflow:hidden;color:#3b4659;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.connection-editor{min-width:0;min-height:0;overflow-y:auto;scrollbar-gutter:stable;padding:20px 22px}.editor-title,.subsection-title{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:nowrap}.editor-title h3{margin:3px 0;color:#2f3c51;font-size:18px}.editor-title>div:last-child{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.probe-result{margin-top:14px;padding:8px 10px;border-radius:7px;color:#2e6b4c;background:#effaf4;font-size:10px}.connection-form,.model-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px;margin-top:20px}.connection-form .span-2,.model-form .span-2{grid-column:1/-1}.secret-card,.oauth-card{margin-top:14px;padding:14px 16px;border:1px solid #dfe6f2;border-radius:10px;background:#f8faff}.secret-card{display:grid;grid-template-columns:minmax(220px,1fr) auto;align-items:center;gap:12px 20px}.secret-card strong,.oauth-card strong{color:#344056;font-size:11px}.secret-title,.oauth-title{display:flex;align-items:center;gap:8px;min-width:0}.secret-card>.el-input{grid-column:1/-1}.oauth-card{display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px 20px}.oauth-actions{display:flex;justify-content:flex-end}.oauth-attempt{grid-column:1/-1;display:flex;align-items:center;gap:8px;padding-top:12px;border-top:1px solid #dfe6f2}.oauth-attempt code{padding:7px 10px;border:1px solid #d7dfed;border-radius:7px;background:#fff;font-size:14px;font-weight:700;letter-spacing:.08em}.subsection-title h4{min-width:0;margin:0;color:#354156;font-size:13px;white-space:nowrap}.models-section{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}.models-section :deep(.el-collapse){margin-top:12px;border-top:1px solid var(--line)}.models-section :deep(.el-collapse-item__header){display:flex;align-items:center;min-height:40px;height:auto;line-height:1.2}.models-section :deep(.el-collapse-item__title){min-width:0;display:block;flex:1}.models-section :deep(.el-collapse-item__arrow){flex:none;margin-left:8px;transition:transform .18s ease}.models-section :deep(.el-collapse-item__arrow.is-active){transform:rotate(90deg)}.models-section :deep(.el-collapse-item__content){padding:0 4px 18px}.model-title{min-width:0;display:flex;align-items:center;gap:10px;flex-wrap:nowrap;overflow:hidden}.model-title strong{min-width:0;overflow:hidden;color:#374357;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.model-title .el-tag{flex:none}.remove-model{align-items:flex-end}.remove-model :deep(.el-form-item__content){justify-content:flex-end}
@media(prefers-reduced-motion:reduce){.models-section :deep(.el-collapse-item__arrow){transition:none}}
@media(max-width:1100px){.binding-row{grid-template-columns:minmax(180px,.7fr) minmax(0,2fr)}}@media(max-width:760px){.load-error{align-items:flex-start;flex-direction:column}.binding-row{grid-template-columns:1fr;padding:14px}.binding-controls{grid-template-columns:1fr}.connections-layout{height:auto;grid-template-columns:1fr}.connection-list{max-height:280px;overflow:auto;border-right:0;border-bottom:1px solid var(--line)}.connection-editor{overflow:visible;scrollbar-gutter:auto;padding:18px 14px}.editor-title,.subsection-title{flex-direction:column}.editor-title>div:last-child{justify-content:flex-start}.connection-form,.model-form{grid-template-columns:1fr}.connection-form .span-2,.model-form .span-2{grid-column:auto}.secret-card,.oauth-card{grid-template-columns:1fr}.secret-card>.el-input,.oauth-attempt{grid-column:auto}.oauth-actions{justify-content:flex-start}.oauth-attempt{align-items:flex-start;flex-wrap:wrap}}
</style>
