<script setup lang="ts">
import {
  ArrowLeft,
  Boxes,
  ChevronRight,
  Sparkles,
  Wrench,
} from '@lucide/vue';
import type { AgentPluginAdmin } from '@contracts';

interface PluginToolRow {
  name: string;
  title: string;
  description: string;
  registered: boolean;
  enabled: boolean;
  main: boolean;
  lockedReason?: string;
}

const props = defineProps<{
  plugin: AgentPluginAdmin;
  tools: PluginToolRow[];
  pending: string;
}>();

const emit = defineEmits<{
  back: [];
  togglePlugin: [enabled: boolean];
  toggleTool: [name: string, enabled: boolean];
  navigate: [section: 'mcp' | 'skills'];
}>();

function stateLabel(): string {
  if (props.plugin.state === 'error') return '异常';
  if (props.plugin.state === 'active') return '运行中';
  return '已停止';
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
        <span class="identity-icon"><Boxes :size="18" /></span>
        <div>
          <h1>{{ plugin.displayName }}</h1>
          <p>{{ plugin.shortDescription }}</p>
          <small>{{ plugin.longDescription }}</small>
        </div>
      </div>
      <div class="identity-state">
        <span class="state-label" :class="{ error: plugin.state === 'error' }">
          <i :class="{ active: plugin.state === 'active', error: plugin.state === 'error' }" />
          {{ stateLabel() }}
        </span>
        <el-switch
          :model-value="plugin.state === 'active'"
          :disabled="!plugin.configurable"
          :loading="pending === `plugin-${plugin.id}`"
          :aria-label="`${plugin.state === 'active' ? '停止' : '启动'} ${plugin.displayName}`"
          @change="emit('togglePlugin', Boolean($event))"
        />
      </div>
    </div>

    <p v-if="plugin.lockedReason" class="locked-note">{{ plugin.lockedReason }}</p>

    <section class="detail-section">
      <div class="detail-section-head">
        <div>
          <h2>Tools</h2>
          <p>开关直接决定 Tool 是否进入 Main Agent；锁定能力只显示状态。</p>
        </div>
      </div>

      <div v-if="tools.length" class="tool-list">
        <article v-for="tool in tools" :key="tool.name" class="tool-row">
          <span class="row-icon"><Wrench :size="16" /></span>
          <span class="row-copy">
            <span><strong>{{ tool.title }}</strong><small>{{ tool.name }}</small></span>
            <span>{{ tool.description }}</span>
            <em v-if="tool.lockedReason">{{ tool.lockedReason }}</em>
          </span>
          <span class="tool-state">
            {{ toolState(tool) }}
          </span>
          <el-switch
            :model-value="toolEnabled(tool)"
            :disabled="!tool.registered || Boolean(tool.lockedReason)"
            :loading="pending === `tool-${tool.name}`"
            :aria-label="`${toolEnabled(tool) ? '停止' : '启动'} ${tool.title}`"
            @change="emit('toggleTool', tool.name, Boolean($event))"
          />
        </article>
      </div>
      <p v-else class="empty-line">当前 Plugin 没有注册 Tool。</p>
    </section>

    <section v-if="plugin.contents.skills.length || plugin.contents.mcpServers.length" class="detail-section">
      <div class="detail-section-head">
        <div>
          <h2>其他内容</h2>
          <p>复杂配置进入对应能力模块。</p>
        </div>
      </div>
      <button
        v-if="plugin.contents.skills.length"
        type="button"
        class="capability-row"
        @click="emit('navigate', 'skills')"
      >
        <span><Sparkles :size="16" />Skills</span>
        <span>{{ plugin.contents.skills.length }}<ChevronRight :size="15" /></span>
      </button>
      <button
        v-if="plugin.contents.mcpServers.length"
        type="button"
        class="capability-row"
        @click="emit('navigate', 'mcp')"
      >
        <span><Boxes :size="16" />MCP Servers</span>
        <span>{{ plugin.contents.mcpServers.length }}<ChevronRight :size="15" /></span>
      </button>
    </section>

    <section class="detail-section built-in-note">
      <h2>内置 Plugin</h2>
      <p>{{ plugin.configurable ? '生命周期由 QQBot 管理；可启停，不能卸载。' : '生命周期由 QQBot 管理；当前产品策略锁定关闭，不能卸载。' }}</p>
    </section>
  </section>
</template>

<style scoped>
.plugin-detail{display:grid;gap:30px;max-width:1180px;margin:0 auto;color:var(--ink);animation:detail-enter .16s ease-out}.detail-nav{display:flex;align-items:center;min-height:32px}.back-button{display:inline-flex;align-items:center;gap:7px;margin:0;padding:5px 2px;border:0;background:transparent;color:var(--muted);font:inherit;cursor:pointer}.back-button:hover{color:var(--ink)}.detail-identity{display:flex;align-items:flex-start;justify-content:space-between;gap:28px}.identity-main{display:flex;align-items:flex-start;gap:13px;min-width:0}.identity-icon,.row-icon{display:grid;place-items:center;flex:0 0 auto;border:1px solid var(--line);background:var(--surface);color:var(--ink)}.identity-icon{width:42px;height:42px;border-radius:10px}.identity-main h1{margin:0;font-size:24px;line-height:1.2;letter-spacing:-.03em}.identity-main p{margin:5px 0 0;color:var(--muted);font-size:13px}.identity-main small{display:block;max-width:700px;margin-top:7px;color:var(--muted);font-size:11px;line-height:1.6}.identity-state{display:flex;align-items:center;gap:12px;font-size:12px}.state-label{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}.state-label i{width:7px;height:7px;border-radius:50%;background:#b5bcc5}.state-label i.active{background:#3a8b68}.state-label i.error{background:#c45d5d}.locked-note{margin:0;padding:11px 14px;border-left:2px solid #b8873f;background:#fffaf1;color:#795c2d;font-size:12px}.detail-section{display:grid;gap:14px;padding-top:26px;border-top:1px solid var(--line)}.detail-section-head h2,.built-in-note h2{margin:0;font-size:16px;letter-spacing:-.02em}.detail-section-head p,.built-in-note p{margin:6px 0 0;color:var(--muted);font-size:12px}.tool-list{border-top:1px solid var(--line)}.tool-row{display:grid;grid-template-columns:38px minmax(0,1fr) auto auto;align-items:center;gap:12px;min-height:68px;padding:10px 6px;border-bottom:1px solid var(--line)}.row-icon{width:36px;height:36px;border-radius:9px}.row-copy{display:flex;min-width:0;flex-direction:column;gap:4px}.row-copy>span:first-child{display:flex;align-items:baseline;gap:9px}.row-copy strong{font-size:13px}.row-copy small{color:var(--muted);font-family:var(--font-mono,ui-monospace,monospace);font-size:10px}.row-copy>span:nth-child(2){overflow:hidden;color:var(--muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.row-copy em{color:#8a642c;font-size:10px;font-style:normal}.tool-state{color:var(--muted);font-size:11px;white-space:nowrap}.empty-line{margin:0;padding:18px 4px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:12px}.capability-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:54px;padding:0 6px;border:0;border-bottom:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}.capability-row>span{display:flex;align-items:center;gap:8px}.built-in-note{padding-bottom:2px}@keyframes detail-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}@media(max-width:720px){.detail-identity{align-items:stretch;flex-direction:column}.identity-state{justify-content:space-between}.tool-row{grid-template-columns:36px minmax(0,1fr) auto}.tool-state{grid-column:2}.tool-row>.el-switch{grid-column:3;grid-row:1/3}}@media(max-width:480px){.tool-row{grid-template-columns:34px minmax(0,1fr)}.tool-state{grid-column:2}.tool-row>.el-switch{grid-column:2;grid-row:auto;justify-self:end}}@media(prefers-reduced-motion:reduce){.plugin-detail{animation:none}}
</style>
