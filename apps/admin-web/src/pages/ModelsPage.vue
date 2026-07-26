<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
} from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  connectionIdSchema,
  emptyRequestSchema,
  modelAdminAggregateSchema,
  modelApplyRequestSchema,
  modelApplyResponseSchema,
  modelCatalogResponseSchema,
  modelConfigPutSchema,
  modelConnectionAuthStateSchema,
  modelConnectionProbeResponseSchema,
  modelIdSchema,
  modelOAuthPollRequestSchema,
  type ModelCatalogResponse,
  type ModelConfigAdminAggregate,
  type ModelConfigDraft,
  type ModelConnectionAuthState,
} from '@contracts';
import PageHeader from '@/components/PageHeader.vue';
import { ApiError, api, jsonBody } from '@/api/client';
import {
  allowedBindingModes,
  buildModelConfigPutInput,
  createModelConfigDraft,
  createSecretDrafts,
  errorMessage,
  incompatibleWorkloadsForModel,
  isModelCompatible,
  isModelDraftDirty,
  isSavedConnectionOperationTarget,
  loadModelPageConfiguration,
  replaceBindingMode,
  structuredOutputProtocolsForRequestMode,
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

const WORKLOAD_DETAILS: Record<string, {
  label: string;
  description: string;
  services: string;
}> = {
  'main.chat': {
    label: '主对话',
    description: '所有普通 ChatLuna 会话的必填模型。',
    services: 'ChatLuna · QQBot reply',
  },
  'memory.extract': {
    label: '记忆提炼',
    description: '从会话中提炼结构化事实和事件。',
    services: 'Memory worker',
  },
  'memory.embedding': {
    label: '记忆向量',
    description: '长期记忆写入和召回使用的 embedding。',
    services: 'Memory worker',
  },
  'affinity.analysis': {
    label: '关系分析',
    description: '关系事件结构化分析；可以继承主对话。',
    services: 'Affinity',
  },
  'naturalTrigger.decision': {
    label: '自然触发判断',
    description: '群聊自然触发的结构化决策模型。',
    services: 'Natural Trigger',
  },
  'search.summary': {
    label: '搜索总结',
    description: '可继承发起当前搜索调用的模型。',
    services: 'ChatLuna Search',
  },
  'chatluna.defaultEmbedding': {
    label: 'ChatLuna 默认向量',
    description: 'ChatLuna 通用 embedding 默认绑定。',
    services: 'ChatLuna core',
  },
  'agent.subagent.default': {
    label: 'Sub-Agent 默认模型',
    description: '所有没有专用 override 的 Agent 使用此绑定。',
    services: 'ChatLuna Agent',
  },
  'sticker.index': {
    label: '表情索引',
    description: '使用 vision 模型生成表情资源的结构化检索元数据。',
    services: 'Sticker maintenance',
  },
};

const MODE_LABELS: Record<BindingMode, string> = {
  dedicated: '专用模型',
  disabled: '禁用',
  inheritMain: '继承主对话',
  inheritInvocation: '继承调用会话',
};

const DERIVED_BINDINGS = [
  { feature: 'Automation', source: 'inheritInvocation', detail: '执行时沿用 live main.chat；来源会话只提供上下文与预设。' },
  { feature: 'Affinity proactive', source: 'inheritInvocation', detail: '执行时沿用 live main.chat；来源会话只提供上下文与预设。' },
  { feature: '校园与原生工具', source: 'inheritInvocation', detail: '工具本身不持有独立模型配置。' },
];

const saved = ref<ModelConfigAdminAggregate | null>(null);
const draft = ref<ModelConfigDraft | null>(null);
const secretDrafts = reactive<SecretDrafts>({});
const selectedConnectionId = ref('');
const connectionQuery = ref('');
const modelLoadError = ref<string | null>(null);
const loading = ref(false);
const saving = ref(false);
const applying = ref(false);
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
}

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const result = await loadModelPageConfiguration(api('/models', modelAdminAggregateSchema));
    modelLoadError.value = result.requiredError;
    if (result.modelState) hydrate(result.modelState);
  } finally {
    loading.value = false;
  }
}

async function refreshSavedState(): Promise<void> {
  if (applying.value) return;
  if (hasUnsavedChanges.value) {
    try {
      await ElMessageBox.confirm(
        '刷新会丢弃整个模型配置草稿，包括尚未保存的连接、档案、绑定和密钥操作。',
        '放弃未保存修改？',
        { type: 'warning', confirmButtonText: '放弃并刷新', cancelButtonText: '继续编辑' },
      );
    } catch {
      return;
    }
  }
  await load();
}

async function save(): Promise<void> {
  if (!saved.value || !draft.value || saving.value || applying.value) return;
  saving.value = true;
  try {
    const input = buildModelConfigPutInput(saved.value, draft.value, secretDrafts);
    const aggregate = await api('/models', modelAdminAggregateSchema, {
      method: 'PUT',
      body: jsonBody(modelConfigPutSchema, input),
    });
    hydrate(aggregate);
    ElMessage.success(`模型配置已保存为 revision ${aggregate.savedRevision}，等待重启应用。`);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitUntilApplied(expectedRevision: number): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await delay(1_000);
    try {
      const aggregate = await api('/models', modelAdminAggregateSchema);
      if (aggregate.appliedRevision >= expectedRevision) {
        hydrate(aggregate);
        return;
      }
    } catch {
      // Koishi is expected to be temporarily unavailable while systemd restarts it.
    }
  }
  throw new Error(`Koishi 重启后没有在 90 秒内应用 revision ${expectedRevision}。`);
}

async function applySavedRevision(): Promise<void> {
  if (!saved.value || applying.value) return;
  if (hasUnsavedChanges.value) {
    ElMessage.warning('请先保存或放弃当前草稿，再重启应用已保存 revision。');
    return;
  }
  if (!saved.value.pending) {
    ElMessage.info('saved revision 已经在运行中。');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将重启 qqbot-koishi.service 并应用 revision ${saved.value.savedRevision}，管理页面会短暂断开。`,
      '重启应用模型配置？',
      { type: 'warning', confirmButtonText: '重启应用', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }

  const expectedRevision = saved.value.savedRevision;
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  applying.value = true;
  try {
    try {
      await api('/models/apply', modelApplyResponseSchema, {
        method: 'POST',
        body: jsonBody(modelApplyRequestSchema, { expectedRevision }),
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // The accepted response may be interrupted by the service restart.
    }
    await waitUntilApplied(expectedRevision);
    ElMessage.success(`revision ${expectedRevision} 已进入运行时。`);
  } catch (error) {
    ElMessage.error(errorMessage(error, '模型配置应用失败'));
  } finally {
    applying.value = false;
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
  const models = draft.value.models.filter((model) => model.connectionId === connection.id);
  if (models.length > 0) {
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
  delete secretDrafts[connection.id];
  selectedConnectionId.value = draft.value.connections[0]?.id ?? '';
}

async function addModelProfile(): Promise<void> {
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
      modelType: 'chat',
      contextSize: 128_000,
      requestMode: selectedConnection.value.adapter === 'codexBridge'
        ? 'responses'
        : 'chat_completions',
      structuredOutputProtocol: null,
      capabilities: {
        chat: true,
        embedding: false,
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

function setModelType(model: ModelProfileDraft, value: unknown): void {
  if (isSavedModel(model)) {
    ElMessage.warning('已保存 model profile 的类型不可修改；请创建新的 canonical model ID。');
    return;
  }
  if (value === 'embedding') {
    if (modelConnectionAdapter(model) !== 'openaiCompatible') {
      ElMessage.warning('Bridge connection 只允许创建 chat model profile。');
      return;
    }
    model.modelType = 'embedding';
    model.requestMode = null;
    model.structuredOutputProtocol = null;
    model.capabilities = {
      chat: false,
      embedding: true,
      vision: false,
      tools: false,
      structuredOutput: false,
    };
    return;
  }
  model.modelType = 'chat';
  model.requestMode = modelConnectionAdapter(model) === 'codexBridge'
    ? 'responses'
    : 'chat_completions';
  model.structuredOutputProtocol = null;
  model.capabilities = {
    chat: true,
    embedding: false,
    vision: false,
    tools: false,
    structuredOutput: false,
  };
}

function isSavedModel(model: ModelProfileDraft): boolean {
  return Boolean(saved.value?.models.some((item) => (
    item.connectionId === model.connectionId && item.id === model.id
  )));
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
  if (model.modelType !== 'chat' || model.requestMode === null) return [];
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
  description: string;
  services: string;
} {
  return WORKLOAD_DETAILS[workload] ?? {
    label: workload.replace(/^agent\.subagent\./, 'Agent · '),
    description: '单个 Agent 的专用模型 override。',
    services: 'ChatLuna Agent',
  };
}

function setBindingMode(index: number, value: unknown): void {
  if (!draft.value) return;
  const binding = draft.value.bindings[index];
  if (!binding || !['dedicated', 'disabled', 'inheritMain', 'inheritInvocation'].includes(String(value))) return;
  try {
    draft.value.bindings[index] = replaceBindingMode(binding, value as BindingMode);
  } catch (error) {
    ElMessage.error(errorMessage(error, '绑定模式无效'));
  }
}

function setBindingConnection(binding: BindingDraft, value: unknown): void {
  if (binding.mode !== 'dedicated') return;
  binding.connectionId = String(value);
  binding.modelId = '';
}

function compatibleModels(binding: BindingDraft): ModelProfileDraft[] {
  if (!draft.value || binding.mode !== 'dedicated' || !binding.connectionId) return [];
  return draft.value.models.filter((model) => (
    model.connectionId === binding.connectionId
    && isModelCompatible(binding.workload, model)
  ));
}

function configuredCanonicalModel(binding: BindingDraft): string | null {
  if (!draft.value || binding.mode !== 'dedicated') return null;
  const model = draft.value.models.find((item) => (
    item.connectionId === binding.connectionId && item.id === binding.modelId
  ));
  return model ? `qqbot-${binding.connectionId}/${model.id}` : null;
}

function liveBinding(workload: string) {
  return saved.value?.liveBindings.find((binding) => binding.workload === workload) ?? null;
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

async function refreshCatalog(connectionId: string): Promise<void> {
  if (operationBusy.value) return;
  operationBusy.value = `catalog:${connectionId}`;
  try {
    const result = await api(
      `/models/connections/${encodeURIComponent(connectionId)}/catalog`,
      modelCatalogResponseSchema,
      { method: 'POST', body: jsonBody(emptyRequestSchema, {}) },
    );
    catalogByConnection[connectionId] = result;
    ElMessage.success(`目录已刷新，共 ${result.models.length} 个 transport models。`);
  } catch (error) {
    ElMessage.error(errorMessage(error, '模型目录刷新失败'));
  } finally {
    operationBusy.value = null;
  }
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
  if (!hasUnsavedChanges.value && !applying.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onBeforeRouteLeave(async () => {
  if (applying.value) {
    ElMessage.warning('正在重启并确认模型 revision，请等待应用完成。');
    return false;
  }
  if (!hasUnsavedChanges.value) return true;
  try {
    await ElMessageBox.confirm(
      '当前模型配置草稿尚未保存，离开页面会丢失这些修改。',
      '离开模型接口？',
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
  <PageHeader
    :saving="saving"
    :save-disabled="!hasUnsavedChanges || !draft || applying"
    save-label="保存模型配置"
    @save="save"
  >
    <template #actions>
      <el-button
        :loading="loading"
        :disabled="applying"
        :title="hasUnsavedChanges ? '放弃整个 aggregate draft 并重新读取' : '读取最新服务端 revision'"
        @click="refreshSavedState"
      >
        {{ hasUnsavedChanges ? '放弃修改' : '刷新状态' }}
      </el-button>
      <el-button
        type="warning"
        plain
        :loading="applying"
        :disabled="!saved?.pending || hasUnsavedChanges"
        @click="applySavedRevision"
      >
        重启应用
      </el-button>
    </template>
  </PageHeader>

  <div v-if="applying" class="apply-lock" role="status" aria-live="assertive">
    <div>
      <strong>正在应用模型配置</strong>
      <span>Koishi 重启期间页面已锁定，正在确认目标 revision 进入运行时。</span>
    </div>
  </div>

  <section v-if="modelLoadError" class="panel load-error">
    <div><strong>模型配置加载失败</strong><p>{{ modelLoadError }}</p></div>
    <el-button type="primary" plain :loading="loading" @click="load">重试加载</el-button>
  </section>

  <template v-if="saved && draft">
    <section class="revision-bar panel">
      <div>
        <span>Saved revision</span>
        <strong>{{ saved.savedRevision }}</strong>
      </div>
      <div>
        <span>Applied revision</span>
        <strong>{{ saved.appliedRevision }}</strong>
      </div>
      <div>
        <span>Draft</span>
        <el-tag :type="hasUnsavedChanges ? 'warning' : 'success'" effect="light">
          {{ hasUnsavedChanges ? '有未保存修改' : '与 saved 同步' }}
        </el-tag>
      </div>
      <div class="revision-state">
        <span>Runtime state</span>
        <el-tag :type="saved.pending ? 'warning' : 'success'" effect="dark">
          {{ saved.pending ? 'Pending · 等待重启' : 'Live · 已应用' }}
        </el-tag>
        <small v-if="saved.pendingReason">{{ saved.pendingReason }}</small>
      </div>
      <div class="revision-time">
        <span>Updated</span>
        <strong>{{ new Date(saved.updatedAt).toLocaleString() }}</strong>
      </div>
    </section>

    <section class="panel binding-panel">
      <div class="panel-head">
        <div>
          <h2>用途绑定</h2>
          <p>每个功能显式声明绑定模式；configured 与 live revision 可以逐项核对。</p>
        </div>
        <el-button size="small" @click="addAgentOverride">新增 Agent override</el-button>
      </div>
      <div class="binding-list">
        <article
          v-for="(binding, index) in draft.bindings"
          :key="binding.workload"
          class="binding-row"
        >
          <div class="binding-purpose">
            <strong>{{ bindingMeta(binding.workload).label }}</strong>
            <code>{{ binding.workload }}</code>
            <p>{{ bindingMeta(binding.workload).description }}</p>
            <small>影响：{{ bindingMeta(binding.workload).services }}</small>
          </div>
          <div class="binding-controls">
            <el-select
              :model-value="binding.mode"
              aria-label="绑定模式"
              @change="setBindingMode(index, $event)"
            >
              <el-option
                v-for="mode in allowedBindingModes(binding.workload)"
                :key="mode"
                :value="mode"
                :label="MODE_LABELS[mode]"
              />
            </el-select>
            <template v-if="binding.mode === 'dedicated'">
              <el-select
                :model-value="binding.connectionId"
                filterable
                placeholder="选择 connection"
                aria-label="绑定 connection"
                @change="setBindingConnection(binding, $event)"
              >
                <el-option
                  v-for="connection in draft.connections"
                  :key="connection.id"
                  :value="connection.id"
                  :label="connection.displayName"
                />
              </el-select>
              <el-select
                v-model="binding.modelId"
                filterable
                placeholder="选择兼容模型"
                aria-label="绑定 model"
              >
                <el-option
                  v-for="model in compatibleModels(binding)"
                  :key="model.id"
                  :value="model.id"
                  :label="model.displayName"
                >
                  <span>{{ model.displayName }}</span>
                  <small class="option-id">{{ model.id }}</small>
                </el-option>
              </el-select>
            </template>
          </div>
          <div class="binding-state">
            <div>
              <span>Configured</span>
              <strong>{{ configuredCanonicalModel(binding) || MODE_LABELS[binding.mode] }}</strong>
            </div>
            <div>
              <span>Live · revision {{ liveBinding(binding.workload)?.revision ?? '—' }}</span>
              <strong>{{ liveBinding(binding.workload)?.canonicalModel || MODE_LABELS[liveBinding(binding.workload)?.mode ?? binding.mode] }}</strong>
            </div>
          </div>
          <el-button
            v-if="!WORKLOAD_DETAILS[binding.workload]"
            class="remove-binding"
            text
            type="danger"
            @click="removeAgentOverride(index)"
          >
            删除
          </el-button>
        </article>
      </div>
    </section>

    <section class="panel inheritance-panel">
      <div class="panel-head">
        <div><h2>只读继承关系</h2><p>这些功能从真实调用会话解析模型，不创建额外 override。</p></div>
      </div>
      <div class="inheritance-grid">
        <article v-for="item in DERIVED_BINDINGS" :key="item.feature">
          <strong>{{ item.feature }}</strong>
          <el-tag size="small" effect="plain">{{ item.source }}</el-tag>
          <p>{{ item.detail }}</p>
        </article>
      </div>
    </section>

    <section class="panel connections-panel">
      <div class="panel-head">
        <div>
          <h2>接口连接与模型档案</h2>
          <p>Connection 管理 endpoint 与认证；Model profile 管理 transport contract 和 capabilities。</p>
        </div>
        <el-button type="primary" plain size="small" @click="createConnectionOpen = true">新增连接</el-button>
      </div>
      <div class="connections-layout">
        <aside class="connection-list">
          <el-input
            v-model="connectionQuery"
            clearable
            placeholder="搜索名称、ID 或 adapter"
            aria-label="搜索接口连接"
          />
          <button
            v-for="connection in filteredConnections"
            :key="connection.id"
            :class="{ active: connection.id === selectedConnectionId }"
            @click="selectedConnectionId = connection.id"
          >
            <span>
              <strong>{{ connection.displayName }}</strong>
              <small>{{ connection.id }}</small>
            </span>
            <el-tag
              size="small"
              :type="connectionAuthState(connection.id)?.status === 'ready' || connectionAuthState(connection.id)?.status === 'not_required' ? 'success' : 'warning'"
              effect="light"
            >
              {{ connectionAuthState(connection.id)?.status ?? 'draft' }}
            </el-tag>
          </button>
        </aside>

        <div v-if="selectedConnection" class="connection-editor">
          <div class="editor-title">
            <div>
              <span class="eyebrow">CONNECTION</span>
              <h3>{{ selectedConnection.displayName }}</h3>
              <code>{{ selectedConnection.id }}</code>
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
                :loading="operationBusy === `catalog:${selectedConnection.id}`"
                :disabled="!canOperateSelectedConnection"
                @click="refreshCatalog(selectedConnection.id)"
              >
                刷新目录
              </el-button>
              <el-button type="danger" plain @click="removeSelectedConnection">删除连接</el-button>
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
            :title="`连接操作只针对已保存 revision ${saved?.savedRevision}；请先保存或放弃当前连接与凭据修改。`"
          />

          <el-form label-position="top" class="connection-form">
            <el-form-item label="Canonical ID">
              <el-input :model-value="selectedConnection.id" disabled />
              <small>ID 创建后不可修改，所有模型和用途绑定都引用它。</small>
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
            <div>
              <strong>API key</strong>
              <p>
                当前：
                {{ savedConnection?.credentialState === 'configured' ? '已加密配置' : '缺失' }}。
                Secret 不会由 GET API 返回。
              </p>
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
            <div>
              <strong>{{ selectedConnection.auth.provider }} OAuth</strong>
              <p>{{ selectedAuthState?.accountLabel || selectedAuthState?.error || selectedAuthState?.status || '尚未读取状态' }}</p>
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

          <section v-if="catalogByConnection[selectedConnection.id]" class="catalog-card">
            <div class="subsection-title">
              <div>
                <h4>Provider catalog</h4>
                <p>目录只提供可选 transport model；保存前仍需明确维护完整 profile。</p>
              </div>
              <el-tag effect="plain">{{ catalogByConnection[selectedConnection.id]?.models.length }} models</el-tag>
            </div>
            <div class="catalog-list">
              <span
                v-for="entry in catalogByConnection[selectedConnection.id]?.models"
                :key="entry.transportModel"
              >
                <strong>{{ entry.displayName }}</strong>
                <code>{{ entry.transportModel }}</code>
              </span>
            </div>
          </section>

          <section class="models-section">
            <div class="subsection-title">
              <div>
                <h4>Model profiles</h4>
                <p>{{ selectedConnectionModels.length }} 个档案；canonical runtime ID 采用 qqbot-&lt;connectionId&gt;/&lt;modelId&gt;。</p>
              </div>
              <el-button size="small" @click="addModelProfile">新增模型档案</el-button>
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
                    <code>qqbot-{{ model.connectionId }}/{{ model.id }}</code>
                    <el-tag size="small" effect="plain">{{ model.modelType }}</el-tag>
                  </div>
                </template>
                <el-form label-position="top" class="model-form">
                  <el-form-item label="Canonical model ID">
                    <el-input :model-value="model.id" disabled />
                  </el-form-item>
                  <el-form-item label="显示名称">
                    <el-input v-model="model.displayName" />
                  </el-form-item>
                  <el-form-item label="Transport model">
                    <el-input v-model="model.transportModel" />
                  </el-form-item>
                  <el-form-item label="Model type">
                    <el-segmented
                      :model-value="model.modelType"
                      :disabled="isSavedModel(model) || modelConnectionAdapter(model) !== 'openaiCompatible'"
                      :options="[
                        { label: 'Chat', value: 'chat' },
                        {
                          label: 'Embedding',
                          value: 'embedding',
                          disabled: modelConnectionAdapter(model) !== 'openaiCompatible',
                        },
                      ]"
                      @change="setModelType(model, $event)"
                    />
                  </el-form-item>
                  <el-form-item label="Context size">
                    <el-input-number v-model="model.contextSize" :min="1" :controls="false" style="width:100%" />
                  </el-form-item>
                  <el-form-item label="Timeout (ms)">
                    <el-input-number v-model="model.timeoutMs" :min="1000" :max="600000" :controls="false" style="width:100%" />
                  </el-form-item>
                  <el-form-item v-if="model.modelType === 'chat'" label="Request mode">
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
                  <el-form-item v-if="model.modelType === 'chat'" label="Structured output protocol">
                    <el-select
                      :model-value="model.structuredOutputProtocol"
                      clearable
                      style="width:100%"
                      @change="setStructuredOutput(model, $event)"
                    >
                      <el-option :value="null" label="无" />
                      <el-option
                        v-for="protocol in structuredOutputOptions(model)"
                        :key="protocol"
                        :value="protocol"
                        :label="protocol"
                      />
                    </el-select>
                  </el-form-item>
                  <el-form-item v-if="model.modelType === 'chat'" label="Capabilities" class="span-2">
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
                  <el-form-item v-if="model.modelType === 'chat'" label="Reasoning effort">
                    <el-select v-model="model.requestDefaults.reasoningEffort" clearable style="width:100%">
                      <el-option v-for="effort in ['none','minimal','low','medium','high','xhigh']" :key="effort" :value="effort" :label="effort" />
                    </el-select>
                  </el-form-item>
                  <el-form-item v-if="model.modelType === 'chat'" label="Thinking mode">
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
  </template>

  <el-dialog v-model="createConnectionOpen" title="新增接口连接" width="min(520px, 92vw)">
    <el-form label-position="top">
      <el-form-item label="Canonical ID">
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
      <el-button type="primary" @click="createConnectionDraft">创建连接草稿</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.apply-lock{position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:24px;background:rgba(246,248,252,.82);backdrop-filter:blur(3px)}.apply-lock>div{display:grid;gap:7px;max-width:420px;padding:20px 24px;border:1px solid #d7dfec;border-radius:12px;background:#fff;box-shadow:0 16px 50px rgba(43,58,86,.16);text-align:center}.apply-lock strong{color:#344056;font-size:14px}.apply-lock span{color:#768196;font-size:10px;line-height:1.6}
.load-error{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 20px;color:#923b3b;background:#fff5f5}.load-error strong{font-size:13px}.load-error p{margin:4px 0 0;font-size:10px}.revision-bar{display:grid;grid-template-columns:repeat(3,minmax(120px,.7fr)) minmax(220px,1.2fr) minmax(180px,1fr);align-items:center;margin-bottom:16px;overflow:hidden}.revision-bar>div{min-width:0;min-height:64px;display:flex;align-items:flex-start;justify-content:center;flex-direction:column;gap:5px;padding:12px 16px;border-right:1px solid var(--line)}.revision-bar>div:last-child{border-right:0}.revision-bar span{color:#8590a2;font-size:9px;text-transform:uppercase}.revision-bar strong{overflow:hidden;max-width:100%;color:#2f3b50;font-family:"SFMono-Regular",Consolas,monospace;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.revision-state{align-items:flex-start!important}.revision-state small{color:#956b26;font-family:monospace;font-size:9px}.binding-panel,.inheritance-panel,.connections-panel{margin-bottom:16px;overflow:hidden}.binding-list{display:grid}.binding-row{position:relative;display:grid;grid-template-columns:minmax(220px,1.1fr) minmax(260px,1.3fr) minmax(230px,1fr);gap:18px;align-items:center;padding:15px 18px;border-top:1px solid var(--line)}.binding-row:first-child{border-top:0}.binding-purpose{min-width:0}.binding-purpose strong,.binding-purpose code{display:block}.binding-purpose strong{color:#344056;font-size:12px}.binding-purpose code{margin-top:2px;color:#7d8797;font-size:9px}.binding-purpose p{margin:7px 0 3px;color:#687488;font-size:10px;line-height:1.5}.binding-purpose small{color:#98a1af;font-size:9px}.binding-controls{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.binding-controls>.el-select:first-child:last-child{grid-column:1/-1}.binding-state{display:grid;grid-template-columns:1fr;gap:7px}.binding-state>div{min-width:0;padding:7px 10px;border:1px solid #e7ebf2;border-radius:7px;background:#fafbfd}.binding-state span,.binding-state strong{display:block}.binding-state span{color:#9099a8;font-size:8px;text-transform:uppercase}.binding-state strong{overflow:hidden;margin-top:2px;color:#445066;font-family:"SFMono-Regular",Consolas,monospace;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.remove-binding{position:absolute;right:8px;top:4px}.option-id{float:right;margin-left:20px;color:#929baa;font-family:monospace;font-size:9px}.inheritance-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:16px 18px}.inheritance-grid article{padding:13px;border:1px solid #e4e9f1;border-radius:9px;background:#fafbfd}.inheritance-grid strong{margin-right:8px;color:#354157;font-size:11px}.inheritance-grid p{margin:7px 0 0;color:#748095;font-size:10px;line-height:1.5}.connections-layout{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:560px}.connection-list{padding:12px;border-right:1px solid var(--line);background:#fbfcfe}.connection-list>.el-input{margin-bottom:10px}.connection-list>button{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;border:0;border-radius:8px;background:transparent;text-align:left}.connection-list>button:hover,.connection-list>button.active{background:#eef3ff}.connection-list>button.active{box-shadow:inset 3px 0 #416de0}.connection-list span{min-width:0}.connection-list strong,.connection-list small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.connection-list strong{color:#3b4659;font-size:11px}.connection-list small{margin-top:3px;color:#929aa8;font-family:monospace;font-size:9px}.connection-editor{min-width:0;padding:20px 22px}.editor-title,.subsection-title{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.editor-title h3{margin:3px 0;color:#2f3c51;font-size:18px}.editor-title code{color:#7b879b;font-size:10px}.editor-title>div:last-child{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.eyebrow{color:#8490a4;font-size:9px;letter-spacing:.08em}.probe-result{margin-top:14px;padding:8px 10px;border-radius:7px;color:#2e6b4c;background:#effaf4;font-size:10px}.connection-form,.model-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px;margin-top:20px}.connection-form .span-2,.model-form .span-2{grid-column:1/-1}.connection-form small{display:block;margin-top:4px;color:#8c96a6;font-size:9px}.secret-card,.oauth-card,.catalog-card{margin-top:14px;padding:14px 16px;border:1px solid #dfe6f2;border-radius:10px;background:#f8faff}.secret-card{display:grid;grid-template-columns:minmax(220px,1fr) auto;align-items:center;gap:12px 20px}.secret-card strong,.oauth-card strong{color:#344056;font-size:11px}.secret-card p,.oauth-card p{margin:3px 0 0;color:#7d8798;font-size:9px}.secret-card>.el-input{grid-column:1/-1}.oauth-card{display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px 20px}.oauth-actions{display:flex;justify-content:flex-end}.oauth-attempt{grid-column:1/-1;display:flex;align-items:center;gap:8px;padding-top:12px;border-top:1px solid #dfe6f2}.oauth-attempt code{padding:7px 10px;border:1px solid #d7dfed;border-radius:7px;background:#fff;font-size:14px;font-weight:700;letter-spacing:.08em}.catalog-card{background:#fbfcfe}.subsection-title h4{margin:0;color:#354156;font-size:13px}.subsection-title p{margin:4px 0 0;color:#818b9c;font-size:9px}.catalog-list{display:flex;gap:7px;flex-wrap:wrap;max-height:150px;overflow:auto;margin-top:12px}.catalog-list>span{display:inline-flex;gap:6px;padding:6px 8px;border:1px solid #e3e8f0;border-radius:6px;background:#fff}.catalog-list strong{color:#48546a;font-size:9px}.catalog-list code{color:#8b94a4;font-size:8px}.models-section{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}.models-section :deep(.el-collapse){margin-top:12px;border-top:1px solid var(--line)}.models-section :deep(.el-collapse-item__content){padding:0 4px 18px}.model-title{min-width:0;display:flex;align-items:center;gap:10px}.model-title strong{color:#374357;font-size:11px}.model-title code{overflow:hidden;color:#8490a3;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.remove-model{align-items:flex-end}.remove-model :deep(.el-form-item__content){justify-content:flex-end}
@media(max-width:1100px){.revision-bar{grid-template-columns:repeat(3,1fr)}.revision-bar>div:nth-child(3){border-right:0}.revision-bar>div:nth-child(n+4){border-top:1px solid var(--line)}.revision-state{grid-column:span 2}.binding-row{grid-template-columns:minmax(220px,1fr) minmax(300px,1.5fr)}.binding-state{grid-column:1/-1;grid-template-columns:repeat(2,minmax(0,1fr))}.inheritance-grid{grid-template-columns:1fr}}@media(max-width:760px){.load-error{align-items:flex-start;flex-direction:column}.revision-bar{grid-template-columns:repeat(2,minmax(0,1fr))}.revision-bar>div{border-top:1px solid var(--line)}.revision-bar>div:nth-child(odd){border-right:1px solid var(--line)}.revision-bar>div:nth-child(even){border-right:0}.revision-state,.revision-time{grid-column:1/-1}.binding-row{grid-template-columns:1fr;padding:14px}.binding-controls{grid-template-columns:1fr}.binding-state{grid-template-columns:1fr}.connections-layout{grid-template-columns:1fr}.connection-list{max-height:280px;overflow:auto;border-right:0;border-bottom:1px solid var(--line)}.connection-editor{padding:18px 14px}.editor-title,.subsection-title{flex-direction:column}.editor-title>div:last-child{justify-content:flex-start}.connection-form,.model-form{grid-template-columns:1fr}.connection-form .span-2,.model-form .span-2{grid-column:auto}.secret-card,.oauth-card{grid-template-columns:1fr}.secret-card>.el-input,.oauth-attempt{grid-column:auto}.oauth-actions{justify-content:flex-start}.oauth-attempt{align-items:flex-start;flex-wrap:wrap}}
</style>
