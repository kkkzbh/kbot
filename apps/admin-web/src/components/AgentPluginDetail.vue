<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cloud,
  Laptop,
  Monitor,
  RotateCw,
  Sparkles,
  SquareTerminal,
  Wrench,
} from '@lucide/vue';
import type {
  AgentComputerAdminConfig,
  AgentPluginAdmin,
  SettingsField,
} from '@contracts';
import ManagedSettingsGrid from '@/components/ManagedSettingsGrid.vue';

type SecretDraft = { value: string; clear: boolean; configured: boolean };
type ComputerBackend = 'local' | 'e2b' | 'open-terminal';
type AgentSection = 'mcp' | 'tools' | 'skills';
type PluginToolRow = {
  name: string;
  title: string;
  description: string;
  registered: boolean;
  enabled: boolean;
  main: boolean;
  lockedReason?: string;
};
type WorkspacePlugin = AgentPluginAdmin & {
  kind: 'workspace';
  computer: NonNullable<AgentPluginAdmin['computer']>;
};

const props = defineProps<{
  plugin: WorkspacePlugin;
  tools: PluginToolRow[];
  fileSystemFields: SettingsField[];
  pending: string;
  dirty: boolean;
  saveDisabled: boolean;
}>();

const emit = defineEmits<{
  back: [];
  save: [];
  togglePlugin: [enabled: boolean];
  probe: [backend: ComputerBackend];
  navigate: [section: AgentSection];
  toggleTool: [name: string, enabled: boolean];
  openTool: [name: string];
}>();

const draft = defineModel<AgentComputerAdminConfig>('draft', { required: true });
const e2bKey = defineModel<SecretDraft>('e2bKey', { required: true });
const openTerminalKey = defineModel<SecretDraft>('openTerminalKey', { required: true });
const fileSystemDraft = defineModel<Record<string, string>>('fileSystemDraft', { required: true });
const fileSystemClearSecrets = defineModel<Record<string, boolean>>('fileSystemClearSecrets', { required: true });
const expandedBackend = ref<ComputerBackend | null>('local');

const idleMinutes = computed({
  get: () => Math.max(1, Math.round(draft.value.idleTimeoutMs / 60_000)),
  set: (minutes: number) => {
    draft.value.idleTimeoutMs = minutes * 60_000;
  },
});

const enabled = computed(() => props.plugin.state === 'active');

const stateLabel = computed(() => {
  if (!enabled.value) return '已停止';
  if (props.plugin.state === 'error') return '异常';
  return '运行中';
});

const capabilityRows = computed(() => [
  {
    key: 'mcp' as const,
    label: 'MCP',
    title: 'MCP Servers',
    description: '由 Plugin 管理的协议服务',
    count: props.plugin.contents.mcpServers.length,
    icon: Monitor,
  },
  {
    key: 'skills' as const,
    label: 'Skills',
    title: 'Skills',
    description: '随 Plugin 启用的操作说明',
    count: props.plugin.contents.skills.length,
    icon: Sparkles,
  },
].filter((row) => row.count > 0));
const contentSummary = computed(() => [
  props.plugin.contents.mcpServers.length
    ? `${props.plugin.contents.mcpServers.length} MCP`
    : '',
  props.plugin.contents.skills.length
    ? `${props.plugin.contents.skills.length} Skills`
    : '',
  props.plugin.contents.tools.length
    ? `${props.plugin.contents.tools.length} Tools`
    : '',
].filter(Boolean).join(' · '));

function backendState(backend: ComputerBackend): string {
  const status = props.plugin.computer.status.backends[backend];
  if (backend === 'local' && !draft.value.local.enabled) return '未启用';
  if (backend === 'e2b' && !draft.value.e2b.enabled) return '未启用';
  if (backend === 'open-terminal' && !draft.value.openTerminal.enabled) return '未启用';
  if (status.state === 'connected') return '可用';
  if (status.state === 'connecting') return '连接中';
  if (status.state === 'unsupported') return '不支持';
  if (status.state === 'error') return '异常';
  return '就绪';
}

function toggleBackend(backend: ComputerBackend): void {
  expandedBackend.value = expandedBackend.value === backend ? null : backend;
}

function toolEnabled(tool: PluginToolRow): boolean {
  return tool.registered && !tool.lockedReason && tool.enabled && tool.main;
}

function toolState(tool: PluginToolRow): string {
  if (tool.lockedReason) return '策略锁定关闭';
  if (!tool.registered) return '未注册';
  return tool.enabled && tool.main ? 'Agent 中启用' : '已停止';
}
</script>

<template>
  <section class="plugin-detail">
    <header class="detail-nav">
      <button type="button" class="back-button" @click="emit('back')">
        <ArrowLeft :size="16" />
        Plugin
      </button>
    </header>

    <div class="detail-identity">
      <div class="identity-main">
        <span class="identity-icon"><Monitor :size="18" /></span>
        <div>
          <h1>{{ plugin.displayName }}</h1>
          <p>{{ plugin.shortDescription }}</p>
          <small>{{ contentSummary }}</small>
        </div>
      </div>
      <div class="identity-state">
        <span class="state-label" :class="{ error: plugin.state === 'error' }">
          <i :class="{ active: enabled, error: plugin.state === 'error' }" />
          {{ stateLabel }}
        </span>
        <span>启用 Plugin</span>
        <el-switch
          :model-value="enabled"
          :loading="pending === 'plugin-workspace'"
          aria-label="启用 Workspace Plugin"
          @change="emit('togglePlugin', Boolean($event))"
        />
      </div>
    </div>

    <section class="detail-section">
      <div class="detail-section-head">
        <div>
          <h2>包含的能力</h2>
          <p>常用设置保留在当前页面；MCP 与 Skills 的完整编辑进入对应模块。</p>
        </div>
      </div>

      <div v-if="capabilityRows.length" class="detail-list">
        <button
          v-for="row in capabilityRows"
          :key="row.key"
          type="button"
          class="capability-row"
          @click="emit('navigate', row.key)"
        >
          <span class="capability-main">
            <span class="row-icon"><component :is="row.icon" :size="17" /></span>
            <span class="row-copy">
              <span><em>{{ row.label }}</em><strong>{{ row.title }}</strong></span>
              <small>{{ row.description }}</small>
            </span>
          </span>
          <span class="capability-count">
            {{ row.count }}
            <ChevronRight :size="16" />
          </span>
        </button>
      </div>
      <p v-else-if="!tools.length" class="empty-line">当前 Plugin 没有注册能力。</p>

      <div v-if="tools.length" class="workspace-tools">
        <article v-for="tool in tools" :key="tool.name" class="workspace-tool-row">
          <button type="button" class="workspace-tool-select" @click="emit('openTool', tool.name)">
            <span class="row-icon"><Wrench :size="16" /></span>
            <span class="row-copy">
              <span><strong>{{ tool.title }}</strong><small>{{ tool.name }}</small></span>
              <span>{{ tool.description }}</span>
              <em v-if="tool.lockedReason">{{ tool.lockedReason }}</em>
            </span>
          </button>
          <span class="tool-state">{{ toolState(tool) }}</span>
          <el-switch
            :model-value="toolEnabled(tool)"
            :disabled="!tool.registered || Boolean(tool.lockedReason)"
            :loading="pending === `tool-${tool.name}`"
            :aria-label="`${toolEnabled(tool) ? '停止' : '启动'} ${tool.title}`"
            @change="emit('toggleTool', tool.name, Boolean($event))"
          />
          <ChevronRight class="tool-chevron" :size="16" />
        </article>
      </div>
    </section>

    <section class="detail-section">
      <div class="detail-section-head">
        <div>
          <h2>运行方式</h2>
          <p>选择默认 backend，并配置可用的执行环境。</p>
        </div>
      </div>

      <el-form label-position="top" class="runtime-form">
        <div class="form-grid two">
          <el-form-item label="Default backend">
            <el-select v-model="draft.defaultProvider">
              <el-option label="Local" value="local" />
              <el-option label="E2B" value="e2b" />
              <el-option label="OpenTerminal" value="open-terminal" />
            </el-select>
          </el-form-item>
          <el-form-item label="Idle timeout（分钟）">
            <el-input-number v-model="idleMinutes" :min="1" :max="1440" />
          </el-form-item>
        </div>

        <div class="backend-list">
          <section class="backend-item">
            <div class="backend-row">
              <div class="backend-main">
                <span class="row-icon"><Laptop :size="17" /></span>
                <span class="row-copy"><strong>Local</strong><small>{{ backendState('local') }}</small></span>
              </div>
              <div class="backend-actions">
                <el-switch v-model="draft.local.enabled" aria-label="启用 Local backend" />
                <el-button text @click="toggleBackend('local')">
                  {{ expandedBackend === 'local' ? '收起' : '配置' }}
                  <ChevronUp v-if="expandedBackend === 'local'" :size="15" />
                  <ChevronDown v-else :size="15" />
                </el-button>
                <el-button text :loading="pending === 'probe-local'" @click="emit('probe', 'local')">
                  <RotateCw :size="15" />探测
                </el-button>
              </div>
            </div>
            <transition name="detail-reveal">
              <div v-if="expandedBackend === 'local'" class="backend-fields">
                <div class="form-grid two">
                  <el-form-item label="Sandbox">
                    <el-select v-model="draft.local.sandboxMode">
                      <el-option label="Read only" value="read-only" />
                      <el-option label="Workspace write" value="workspace-write" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="Network">
                    <el-select v-model="draft.local.networkPolicy">
                      <el-option label="Block" value="block" />
                      <el-option label="Allow" value="allow" />
                    </el-select>
                  </el-form-item>
                </div>
                <el-form-item label="Workspace scope">
                  <el-input v-model="draft.local.scopePath" />
                </el-form-item>
                <div class="form-grid two">
                  <el-form-item label="Allowed commands">
                    <el-select v-model="draft.local.allowedCommands" multiple filterable allow-create default-first-option />
                  </el-form-item>
                  <el-form-item label="Blocked commands">
                    <el-select v-model="draft.local.blockedCommands" multiple filterable allow-create default-first-option />
                  </el-form-item>
                </div>
              </div>
            </transition>
          </section>

          <section class="backend-item">
            <div class="backend-row">
              <div class="backend-main">
                <span class="row-icon"><Cloud :size="17" /></span>
                <span class="row-copy"><strong>E2B</strong><small>{{ backendState('e2b') }}</small></span>
              </div>
              <div class="backend-actions">
                <el-switch v-model="draft.e2b.enabled" aria-label="启用 E2B backend" />
                <el-button text @click="toggleBackend('e2b')">
                  {{ expandedBackend === 'e2b' ? '收起' : '配置' }}
                  <ChevronUp v-if="expandedBackend === 'e2b'" :size="15" />
                  <ChevronDown v-else :size="15" />
                </el-button>
                <el-button text :loading="pending === 'probe-e2b'" @click="emit('probe', 'e2b')">
                  <RotateCw :size="15" />探测
                </el-button>
              </div>
            </div>
            <transition name="detail-reveal">
              <div v-if="expandedBackend === 'e2b'" class="backend-fields">
                <div class="form-grid two">
                  <el-form-item label="Template"><el-input v-model="draft.e2b.template" /></el-form-item>
                  <el-form-item label="API Key">
                    <el-input
                      v-model="e2bKey.value"
                      show-password
                      :disabled="e2bKey.clear"
                      :placeholder="e2bKey.configured ? '留空保留' : '未配置'"
                    />
                  </el-form-item>
                </div>
                <el-checkbox v-if="e2bKey.configured" v-model="e2bKey.clear">清除已保存的 API Key</el-checkbox>
              </div>
            </transition>
          </section>

          <section class="backend-item">
            <div class="backend-row">
              <div class="backend-main">
                <span class="row-icon"><SquareTerminal :size="17" /></span>
                <span class="row-copy"><strong>OpenTerminal</strong><small>{{ backendState('open-terminal') }}</small></span>
              </div>
              <div class="backend-actions">
                <el-switch v-model="draft.openTerminal.enabled" aria-label="启用 OpenTerminal backend" />
                <el-button text @click="toggleBackend('open-terminal')">
                  {{ expandedBackend === 'open-terminal' ? '收起' : '配置' }}
                  <ChevronUp v-if="expandedBackend === 'open-terminal'" :size="15" />
                  <ChevronDown v-else :size="15" />
                </el-button>
                <el-button text :loading="pending === 'probe-open-terminal'" @click="emit('probe', 'open-terminal')">
                  <RotateCw :size="15" />探测
                </el-button>
              </div>
            </div>
            <transition name="detail-reveal">
              <div v-if="expandedBackend === 'open-terminal'" class="backend-fields">
                <div class="form-grid two">
                  <el-form-item label="Base URL"><el-input v-model="draft.openTerminal.baseUrl" /></el-form-item>
                  <el-form-item label="API Key">
                    <el-input
                      v-model="openTerminalKey.value"
                      show-password
                      :disabled="openTerminalKey.clear"
                      :placeholder="openTerminalKey.configured ? '留空保留' : '未配置'"
                    />
                  </el-form-item>
                </div>
                <el-checkbox v-if="openTerminalKey.configured" v-model="openTerminalKey.clear">清除已保存的 API Key</el-checkbox>
              </div>
            </transition>
          </section>
        </div>
      </el-form>
    </section>

    <section class="detail-section">
      <div class="detail-section-head">
        <div>
          <h2>文件与 Shell 边界</h2>
          <p>管理公共文件工具的总开关、作用域目录与允许使用的群聊。</p>
        </div>
      </div>
      <ManagedSettingsGrid
        v-model="fileSystemDraft"
        v-model:clear-secrets="fileSystemClearSecrets"
        :fields="fileSystemFields"
      />
    </section>

    <section class="detail-section built-in-note">
      <div>
        <h2>内置 Plugin</h2>
        <p>Workspace 可停止并清除 Secret；运行时组件由 QQBot 管理，不提供卸载操作。</p>
      </div>
    </section>

    <footer class="detail-savebar">
      <p>{{ dirty ? '有未保存的配置修改。' : '' }}</p>
      <el-button
        type="primary"
        :disabled="!dirty || saveDisabled"
        :loading="pending === 'computer-plugin'"
        @click="emit('save')"
      >
        保存
      </el-button>
    </footer>
  </section>
</template>

<style scoped>
.plugin-detail{display:grid;gap:30px;max-width:1180px;margin:0 auto;color:var(--ink);animation:detail-enter .16s ease-out}
.detail-nav{display:flex;align-items:center;min-height:32px}.back-button{display:inline-flex;align-items:center;gap:7px;margin:0;padding:5px 2px;border:0;background:transparent;color:var(--muted);font:inherit;cursor:pointer}.back-button:hover{color:var(--ink)}
.detail-identity{display:flex;align-items:flex-start;justify-content:space-between;gap:28px}.identity-main{display:flex;align-items:flex-start;gap:13px;min-width:0}.identity-icon,.row-icon{display:grid;place-items:center;flex:0 0 auto;border:1px solid var(--line);background:var(--surface);color:var(--ink)}.identity-icon{width:42px;height:42px;border-radius:10px}.identity-main h1{margin:0;font-size:24px;line-height:1.2;letter-spacing:-.03em}.identity-main p{margin:5px 0 0;color:var(--muted);font-size:13px}.identity-main small{display:block;margin-top:6px;color:var(--muted);font-size:11px}.identity-state{display:flex;align-items:center;gap:10px;font-size:12px}.state-label{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}.state-label i{width:7px;height:7px;border-radius:50%;background:#b5bcc5}.state-label i.active{background:#3a8b68}.state-label i.error{background:#c45d5d}.state-label.error{color:#a85252}
.detail-section{display:grid;gap:14px;padding-top:26px;border-top:1px solid var(--line)}.detail-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.detail-section h2{margin:0;font-size:16px;letter-spacing:-.02em}.detail-section-head p,.built-in-note p{margin:6px 0 0;color:var(--muted);font-size:12px}.detail-list,.backend-list{border-top:1px solid var(--line)}
.capability-row{display:flex;width:100%;min-height:68px;align-items:center;justify-content:space-between;gap:16px;padding:12px 6px;border:0;border-bottom:1px solid var(--line);background:transparent;color:inherit;text-align:left;cursor:pointer;transition:background-color .14s ease}.capability-row:hover{background:color-mix(in srgb,var(--surface) 88%,var(--accent) 12%)}.capability-main,.backend-main{display:flex;align-items:center;gap:12px;min-width:0}.row-icon{width:38px;height:38px;border-radius:9px}.row-copy{display:flex;min-width:0;flex-direction:column;gap:4px}.row-copy>span{display:flex;align-items:center;gap:8px}.row-copy strong{font-size:13px}.row-copy small{color:var(--muted);font-size:11px}.row-copy em{padding:2px 6px;border-radius:5px;background:var(--accent-soft);color:var(--accent);font-size:10px;font-style:normal}.capability-count{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px;white-space:nowrap}.empty-line{margin:0;padding:18px 4px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:12px}
.workspace-tools{border-top:1px solid var(--line)}.workspace-tool-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;align-items:center;gap:12px;min-height:66px;padding:9px 6px;border-bottom:1px solid var(--line);transition:background-color .14s ease}.workspace-tool-row:hover{background:color-mix(in srgb,var(--surface) 88%,var(--accent) 12%)}.workspace-tool-select{display:grid;grid-template-columns:38px minmax(0,1fr);align-items:center;gap:12px;min-width:0;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.workspace-tool-row .row-copy>span:nth-child(2){overflow:hidden;color:var(--muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.tool-state{color:var(--muted);font-size:11px;white-space:nowrap}.tool-chevron{color:var(--muted)}
.runtime-form :deep(.el-select),.runtime-form :deep(.el-input-number){width:100%}.form-grid{display:grid;gap:14px}.form-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.backend-list{margin-top:2px}.backend-item{border-bottom:1px solid var(--line)}.backend-row{display:flex;min-height:66px;align-items:center;justify-content:space-between;gap:16px;padding:10px 6px}.backend-actions{display:flex;align-items:center;gap:4px}.backend-actions :deep(.el-button){display:inline-flex;align-items:center;gap:5px;margin-left:0}.backend-fields{padding:2px 6px 20px 50px}.backend-fields :deep(.el-form-item:last-child){margin-bottom:0}.built-in-note{grid-template-columns:minmax(0,1fr);padding-bottom:2px}
.detail-savebar{display:flex;min-height:54px;align-items:center;justify-content:space-between;gap:16px;padding-top:16px;border-top:1px solid var(--line)}.detail-savebar p{margin:0;color:var(--muted);font-size:12px}.detail-reveal-enter-active,.detail-reveal-leave-active{transition:opacity .14s ease,transform .14s ease}.detail-reveal-enter-from,.detail-reveal-leave-to{opacity:0;transform:translateY(-3px)}
@keyframes detail-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:720px){.detail-identity,.detail-section-head,.detail-savebar{align-items:stretch;flex-direction:column}.identity-state{justify-content:space-between}.form-grid.two{grid-template-columns:1fr}.backend-row{align-items:flex-start;flex-direction:column}.backend-actions{width:100%;justify-content:flex-end}.backend-fields{padding-left:6px}.workspace-tool-row{grid-template-columns:minmax(0,1fr) auto auto}.tool-state{grid-column:1}.workspace-tool-row>.el-switch{grid-column:2;grid-row:1/3}.tool-chevron{grid-column:3;grid-row:1/3}}
@media(max-width:480px){.capability-row{align-items:flex-start;flex-direction:column}.capability-count{align-self:flex-end}.backend-actions{justify-content:space-between;flex-wrap:wrap}.identity-state{align-items:center;flex-wrap:wrap}.workspace-tool-row{grid-template-columns:minmax(0,1fr) auto}.workspace-tool-row>.el-switch{grid-column:1;grid-row:auto;justify-self:end}.tool-chevron{grid-column:2;grid-row:1/4}}
@media(prefers-reduced-motion:reduce){.plugin-detail{animation:none}.detail-reveal-enter-active,.detail-reveal-leave-active{transition:none}}
</style>
