<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  agentMcpToolPutSchema,
  agentToolPutSchema,
  type AgentAdminState,
  type AgentToolPolicyState,
  type ContextSnapshot,
  type ContextSnapshotMessage,
  type ContextTarget,
} from '@contracts';
import { jsonBody, rawApi } from '@/api/client';
import { getContextSnapshot, listContextTargets } from '@/api/context-presets';
import ContextPayloadPreview from '@/components/ContextPayloadPreview.vue';

const router = useRouter();
const targets = ref<ContextTarget[]>([]);
const selectedConversationId = ref('');
const snapshot = shallowRef<ContextSnapshot | null>(null);
const unavailableReason = ref('');
const agent = ref<AgentAdminState | null>(null);
const policy = ref<AgentToolPolicyState | null>(null);
const loading = ref(false);
const pendingTool = ref('');
const expandedMessages = ref(new Set<string>());
const expandedTools = ref(new Set<string>());
const showSemanticPayload = ref(false);
const showExcluded = ref(false);
const exampleOpen = ref(false);

const includedMessages = computed(() => (
  snapshot.value?.messages.filter((message) => message.included)
    .sort((left, right) => left.index - right.index) ?? []
));
const excludedMessages = computed(() => (
  snapshot.value?.messages.filter((message) => !message.included)
    .sort((left, right) => left.index - right.index) ?? []
));
const semanticPayload = computed(() => ({
  messages: includedMessages.value.map((message) => ({
    role: message.role,
    ...(message.name === undefined ? {} : { name: message.name }),
    content: message.content,
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
  })),
  tools: snapshot.value?.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.schema === undefined ? {} : { schema: tool.schema }),
  })) ?? [],
}));

function messagePayload(message: ContextSnapshotMessage): Record<string, unknown> {
  return {
    role: message.role,
    ...(message.name === undefined ? {} : { name: message.name }),
    content: message.content,
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
  };
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function toggleMessage(key: string): void {
  const next = new Set(expandedMessages.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedMessages.value = next;
}

function toggleToolSchema(key: string): void {
  const next = new Set(expandedTools.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedTools.value = next;
}

function runtimeTool(name: string) {
  return agent.value?.tools.catalog.find((tool) => tool.name === name);
}

function mcpTool(name: string) {
  return agent.value?.mcp.tools.find((tool) => tool.name === name);
}

function policyEntry(name: string) {
  return policy.value?.catalog.find((entry) => entry.toolName === name);
}

function toolEnabled(name: string): boolean {
  if (policyEntry(name)?.management === 'locked_off') return false;
  const tool = runtimeTool(name);
  return Boolean(tool?.enabled && tool.main);
}

function toolState(name: string): string {
  const entry = policyEntry(name);
  const tool = runtimeTool(name);
  if (entry?.management === 'locked_off') return entry.managementNote ?? '策略锁定关闭';
  if (!tool) return '当前 runtime 未注册';
  if (!tool.enabled) return '全局停用';
  if (!tool.main) return '未提供给 Main Agent';
  return '未来请求中启用';
}

async function loadAgent(): Promise<void> {
  const [nextAgent, nextPolicy] = await Promise.all([
    rawApi<AgentAdminState>('/agent'),
    rawApi<AgentToolPolicyState>('/agent/tools/policy'),
  ]);
  agent.value = nextAgent;
  policy.value = nextPolicy;
}

async function loadSnapshot(): Promise<void> {
  if (!selectedConversationId.value) {
    snapshot.value = null;
    unavailableReason.value = '选择一个会话后查看最近一次模型输入。';
    return;
  }
  const response = await getContextSnapshot(selectedConversationId.value);
  snapshot.value = response.snapshot;
  unavailableReason.value = response.unavailableReason ?? '';
  expandedMessages.value = new Set();
  expandedTools.value = new Set();
}

async function refresh(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const previous = selectedConversationId.value;
    const [nextTargets] = await Promise.all([listContextTargets(), loadAgent()]);
    targets.value = nextTargets;
    selectedConversationId.value = nextTargets.some((target) => target.conversationId === previous)
      ? previous
      : nextTargets[0]?.conversationId ?? '';
    await loadSnapshot();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '模型输入读取失败');
  } finally {
    loading.value = false;
  }
}

async function selectTarget(value: string | number | boolean | undefined): Promise<void> {
  selectedConversationId.value = String(value ?? '');
  loading.value = true;
  try {
    await loadSnapshot();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '模型输入读取失败');
  } finally {
    loading.value = false;
  }
}

async function toggleTool(name: string, enabled: boolean): Promise<void> {
  const current = runtimeTool(name);
  const entry = policyEntry(name);
  if (!current || entry?.management === 'locked_off' || pendingTool.value) return;
  pendingTool.value = name;
  try {
    const mcp = mcpTool(name);
    if (mcp) {
      await rawApi(`/agent/mcp/tools/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: jsonBody(agentMcpToolPutSchema, {
          enabled,
          timeout: mcp.timeout,
          selector: mcp.selector,
        }),
      });
    } else {
      await rawApi(`/agent/tools/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: jsonBody(agentToolPutSchema, { enabled, main: enabled }),
      });
    }
    await loadAgent();
    ElMessage.success(enabled ? `${name} 将进入未来请求` : `${name} 已从未来请求停用`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Tool 设置失败');
  } finally {
    pendingTool.value = '';
  }
}

async function openAgent(section: 'mcp' | 'skills'): Promise<void> {
  await router.push({ name: 'agent', query: { section } });
}

async function toggleExample(): Promise<void> {
  exampleOpen.value = !exampleOpen.value;
  if (exampleOpen.value && targets.value.length === 0) await refresh();
}
</script>

<template>
  <section class="runtime-inspector">
    <header class="runtime-head">
      <h2>最近请求</h2>
      <div class="runtime-actions">
        <el-select
          v-if="exampleOpen"
          :model-value="selectedConversationId"
          filterable
          :loading="loading"
          placeholder="选择会话"
          aria-label="选择会话"
          @change="selectTarget"
        >
          <el-option
            v-for="target in targets"
            :key="target.conversationId"
            :label="target.label"
            :value="target.conversationId"
          />
        </el-select>
        <el-button v-if="exampleOpen" :loading="loading" @click="refresh">刷新</el-button>
        <el-button text @click="toggleExample">{{ exampleOpen ? '收起' : '查看最近请求' }}</el-button>
      </div>
    </header>

    <template v-if="exampleOpen && snapshot">
      <dl class="request-meta">
        <div><dt>Model</dt><dd>{{ snapshot.model }}</dd></div>
        <div><dt>Mode</dt><dd>{{ snapshot.requestMode ?? 'unknown' }}</dd></div>
        <div><dt>Preset</dt><dd>{{ snapshot.effectivePresetId ?? 'none' }}</dd></div>
        <div><dt>Captured</dt><dd>{{ formatTime(snapshot.createdAt) }}</dd></div>
        <div><dt>Messages</dt><dd>{{ snapshot.finalCount }}</dd></div>
        <div><dt>Input tokens</dt><dd>{{ snapshot.providerInputTokens ?? snapshot.estimatedTokens }}{{ snapshot.providerUsageEstimated ? ' estimated' : '' }}</dd></div>
      </dl>

      <section class="raw-section">
        <div class="section-title">
          <h2>Messages</h2>
          <el-button text @click="showSemanticPayload = !showSemanticPayload">
            {{ showSemanticPayload ? '收起捕获 JSON' : '捕获 JSON' }}
          </el-button>
        </div>
        <ContextPayloadPreview
          v-if="showSemanticPayload"
          class="raw-payload"
          :value="semanticPayload"
          :meta="`messages[${includedMessages.length}] · tools[${snapshot.tools.length}]`"
          :roles="[...new Set(includedMessages.map((message) => message.role))]"
          compact
        />
        <div class="raw-list">
          <article v-for="message in includedMessages" :key="message.id" class="raw-item">
            <button type="button" class="raw-item-head" @click="toggleMessage(message.id)">
              <span><strong>{{ message.index }}</strong><em>{{ message.role }}</em><small>{{ message.stage }} · {{ message.source }}</small></span>
              <span>{{ message.estimatedTokens }} tokens · {{ expandedMessages.has(message.id) ? '收起' : '原文' }}</span>
            </button>
            <ContextPayloadPreview
              v-if="expandedMessages.has(message.id)"
              class="raw-item-payload"
              :value="messagePayload(message)"
              :roles="[message.role]"
              :copyable="false"
              compact
            />
          </article>
        </div>
        <button v-if="excludedMessages.length" type="button" class="excluded-toggle" @click="showExcluded = !showExcluded">
          {{ showExcluded ? '收起' : '查看' }} {{ excludedMessages.length }} 条未进入模型的消息
        </button>
        <div v-if="showExcluded" class="raw-list excluded-list">
          <article v-for="message in excludedMessages" :key="message.id" class="raw-item">
            <button type="button" class="raw-item-head" @click="toggleMessage(message.id)">
              <span><strong>{{ message.index }}</strong><em>{{ message.role }}</em><small>{{ message.dropReason }}</small></span>
              <span>{{ expandedMessages.has(message.id) ? '收起' : '原文' }}</span>
            </button>
            <ContextPayloadPreview
              v-if="expandedMessages.has(message.id)"
              class="raw-item-payload"
              :value="messagePayload(message)"
              :roles="[message.role]"
              :copyable="false"
              compact
            />
          </article>
        </div>
      </section>

      <section class="raw-section">
        <div class="section-title">
          <h2>Tools</h2>
          <div class="secondary-links"><el-button text @click="openAgent('mcp')">管理 MCP</el-button><el-button text @click="openAgent('skills')">管理 Skills</el-button></div>
        </div>
        <div v-if="snapshot.tools.length" class="raw-list">
          <article v-for="tool in snapshot.tools" :key="tool.name" class="raw-item tool-item">
            <button type="button" class="raw-item-head" @click="toggleToolSchema(tool.name)">
              <span><strong>{{ tool.name }}</strong><small>{{ toolState(tool.name) }}</small></span>
              <span>{{ expandedTools.has(tool.name) ? '收起 schema' : '查看 schema' }}</span>
            </button>
            <el-switch
              :model-value="toolEnabled(tool.name)"
              :disabled="!runtimeTool(tool.name) || policyEntry(tool.name)?.management === 'locked_off'"
              :loading="pendingTool === tool.name"
              :aria-label="`配置 ${tool.name}`"
              @change="toggleTool(tool.name, Boolean($event))"
            />
            <ContextPayloadPreview
              v-if="expandedTools.has(tool.name)"
              class="raw-item-payload"
              :value="{ name: tool.name, description: tool.description, schema: tool.schema }"
              :roles="['tool']"
              :copyable="false"
              compact
            />
          </article>
        </div>
        <p v-else class="empty-line">这次请求没有 Tool definitions。</p>
      </section>
    </template>

    <section v-else-if="exampleOpen" class="empty-snapshot">
      <h2>暂无可展示的请求</h2>
      <p>{{ unavailableReason || '让目标会话触发一次模型请求，再刷新这里。' }}</p>
    </section>
  </section>
</template>

<style scoped>
.runtime-inspector{display:grid;gap:22px;max-width:1180px;margin:22px auto 0;padding-top:14px;border-top:1px solid var(--line);color:var(--ink)}.runtime-head{display:flex;align-items:center;justify-content:space-between;gap:24px}.runtime-head h2{margin:0;font-size:13px;letter-spacing:-.01em}.runtime-actions{display:flex;align-items:center;gap:8px}.runtime-actions .el-select{width:280px}.request-meta{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;margin:0;border:1px solid var(--line);background:var(--line)}.request-meta div{min-width:0;padding:11px 12px;background:var(--surface)}.request-meta dt{color:var(--muted);font-size:9px;text-transform:uppercase}.request-meta dd{overflow:hidden;margin:4px 0 0;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.raw-section{display:grid;gap:13px}.section-title{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.section-title h2,.empty-snapshot h2{margin:0;font-size:16px;letter-spacing:-.02em}.secondary-links{display:flex;gap:2px}.raw-payload{margin:0}.raw-list{border-top:1px solid var(--line)}.raw-item{position:relative;border-bottom:1px solid var(--line)}.raw-item-head{display:flex;width:100%;align-items:center;justify-content:space-between;gap:18px;min-height:55px;padding:8px 6px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.raw-item-head>span{display:flex;align-items:baseline;gap:9px;min-width:0}.raw-item-head strong{font-size:12px}.raw-item-head em{color:var(--accent);font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;font-style:normal}.raw-item-head small,.raw-item-head>span:last-child{overflow:hidden;color:var(--muted);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.raw-item-payload{margin:0 6px 12px}.tool-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center}.tool-item .raw-item-payload{grid-column:1/-1}.tool-item>.el-switch{margin-right:6px}.excluded-toggle{justify-self:start;padding:2px 0;border:0;background:transparent;color:var(--muted);font:inherit;font-size:11px;cursor:pointer}.excluded-list{opacity:.72}.empty-line{margin:0;padding:18px 6px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:12px}.empty-snapshot{display:grid;gap:10px;padding:42px 4px;border-top:1px solid var(--line)}.empty-snapshot>p{margin:0;color:var(--muted);font-size:12px;line-height:1.6}@media(max-width:900px){.request-meta{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:680px){.runtime-head,.section-title{align-items:stretch;flex-direction:column}.runtime-actions{align-items:stretch}.runtime-actions .el-select{width:100%}.request-meta{grid-template-columns:repeat(2,minmax(0,1fr))}.raw-item-head>span:first-child{align-items:flex-start;flex-direction:column;gap:3px}}
</style>
