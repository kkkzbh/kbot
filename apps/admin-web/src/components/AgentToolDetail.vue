<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  ArrowLeft,
  Plus,
  ShieldCheck,
  Wrench,
} from '@lucide/vue';
import type { AgentToolPolicyState } from '@contracts';
import {
  buildAgentToolOverride,
  canAddAgentToolOverride,
  createAgentToolOverrideDraft,
  hasAgentToolOverride,
  type AgentPolicyScopeOption,
  type AgentToolOverrideInput,
} from '@/pages/agent-tool-policy';

type ToolDetailItem = {
  name: string;
  title: string;
  description: string;
  source: string;
  registered: boolean;
  enabled: boolean;
  main: boolean;
  routes: Array<'agent' | 'automation'>;
  management: 'editable' | 'locked_off';
  managementNote?: string;
};

const props = defineProps<{
  tool: ToolDetailItem;
  scopeOptions: AgentPolicyScopeOption[];
  routeProfiles: AgentToolPolicyState['routeProfileInfo'];
  pending: string;
  backLabel: string;
}>();

const emit = defineEmits<{
  back: [];
  toggleTool: [name: string, enabled: boolean];
}>();

const overrides = defineModel<AgentToolOverrideInput[]>('overrides', { required: true });
const addOverrideOpen = ref(false);
const overrideDraft = reactive(createAgentToolOverrideDraft());
const overrideScope = ref<AgentPolicyScopeOption | null>(null);

const toolOverrides = computed(() => overrides.value.filter(
  (override) => override.toolName === props.tool.name,
));
const overrideDuplicate = computed(() => hasAgentToolOverride(
  overrides.value,
  overrideDraft,
  overrideScope.value,
));
const overrideReady = computed(() => (
  canAddAgentToolOverride(overrideDraft, overrideScope.value)
  && !overrideDuplicate.value
));
const enabled = computed(() => (
  props.tool.registered
  && props.tool.management !== 'locked_off'
  && props.tool.enabled
  && props.tool.main
));

function stateLabel(): string {
  if (props.tool.management === 'locked_off') return '策略锁定关闭';
  if (!props.tool.registered) return '未注册';
  return enabled.value ? 'Agent 中启用' : '已停止';
}

function routeLabel(route: 'agent' | 'automation'): string {
  return props.routeProfiles.find((profile) => profile.id === route)?.title ?? route;
}

function scopeLabel(override: AgentToolOverrideInput): string {
  return props.scopeOptions.find((scope) => (
    scope.scopeKind === override.scopeKind && scope.scopeId === override.scopeId
  ))?.label ?? override.scopeId;
}

function openAddOverride(): void {
  Object.assign(overrideDraft, createAgentToolOverrideDraft(), {
    toolName: props.tool.name,
    routeProfile: props.tool.routes[0] ?? 'agent',
  });
  overrideScope.value = null;
  addOverrideOpen.value = true;
}

function addOverride(): void {
  overrides.value = [
    ...overrides.value,
    buildAgentToolOverride(overrideDraft, overrideScope.value),
  ];
  addOverrideOpen.value = false;
}

function updateOverrideEnabled(target: AgentToolOverrideInput, value: boolean): void {
  overrides.value = overrides.value.map((override) => (
    override === target ? { ...override, enabled: value } : override
  ));
}

function removeOverride(target: AgentToolOverrideInput): void {
  overrides.value = overrides.value.filter((override) => override !== target);
}
</script>

<template>
  <section class="tool-detail">
    <header class="detail-nav">
      <button type="button" class="back-button" @click="emit('back')">
        <ArrowLeft :size="16" />
        {{ backLabel }}
      </button>
    </header>

    <div class="detail-identity">
      <div class="identity-main">
        <span class="identity-icon"><Wrench :size="18" /></span>
        <div>
          <h1>{{ tool.title }}</h1>
          <p>{{ tool.description }}</p>
          <small>{{ tool.name }} · {{ tool.routes.map(routeLabel).join(' · ') }}</small>
        </div>
      </div>
      <div class="identity-state">
        <span class="state-label"><i :class="{ active: enabled }" />{{ stateLabel() }}</span>
        <el-switch
          :model-value="enabled"
          :disabled="!tool.registered || tool.management === 'locked_off'"
          :loading="pending === `tool-${tool.name}`"
          :aria-label="`${enabled ? '停止' : '启动'} ${tool.title}`"
          @change="emit('toggleTool', tool.name, Boolean($event))"
        />
      </div>
    </div>

    <p v-if="tool.managementNote" class="locked-note">{{ tool.managementNote }}</p>

    <section class="detail-section">
      <div class="detail-section-head">
        <div>
          <h2>调用范围</h2>
          <p>仅记录偏离默认权限的范围；未配置的会话继续继承上一级规则。</p>
        </div>
        <el-button
          :disabled="tool.management === 'locked_off' || !tool.registered"
          @click="openAddOverride"
        >
          <Plus :size="15" />添加范围
        </el-button>
      </div>

      <div v-if="toolOverrides.length" class="scope-list">
        <article
          v-for="override in toolOverrides"
          :key="`${override.routeProfile}-${override.scopeKind}-${override.scopeId}`"
          class="scope-row"
        >
          <span class="scope-icon"><ShieldCheck :size="16" /></span>
          <span class="scope-copy">
            <strong>{{ scopeLabel(override) }}</strong>
            <small>{{ routeLabel(override.routeProfile) }}</small>
          </span>
          <span class="scope-state">{{ override.enabled ? '允许调用' : '禁止调用' }}</span>
          <el-switch
            :model-value="override.enabled"
            inline-prompt
            active-text="开"
            inactive-text="关"
            :disabled="tool.management === 'locked_off'"
            @change="updateOverrideEnabled(override, Boolean($event))"
          />
          <el-button text type="danger" @click="removeOverride(override)">移除</el-button>
        </article>
      </div>
      <p v-else class="empty-line">当前 Tool 完全使用默认范围权限。</p>
    </section>
  </section>

  <el-dialog
    v-model="addOverrideOpen"
    :title="`${tool.title} · 添加范围`"
    width="min(520px, calc(100vw - 32px))"
  >
    <el-form label-position="top">
      <el-form-item label="执行链路">
        <el-select v-model="overrideDraft.routeProfile">
          <el-option
            v-for="route in tool.routes"
            :key="route"
            :label="routeLabel(route)"
            :value="route"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="范围" :error="overrideDuplicate ? '这个范围已有相同覆盖' : ''">
        <el-select v-model="overrideScope" value-key="key" filterable>
          <el-option
            v-for="scope in scopeOptions"
            :key="scope.key"
            :label="scope.label"
            :value="scope"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="允许调用">
        <el-switch v-model="overrideDraft.enabled" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="addOverrideOpen = false">取消</el-button>
      <el-button type="primary" :disabled="!overrideReady" @click="addOverride">添加</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.tool-detail{display:grid;gap:30px;max-width:1180px;margin:0 auto;color:var(--ink);animation:detail-enter .16s ease-out}
.detail-nav{display:flex;min-height:32px;align-items:center}.back-button{display:inline-flex;align-items:center;gap:7px;margin:0;padding:5px 2px;border:0;background:transparent;color:var(--muted);font:inherit;cursor:pointer}.back-button:hover{color:var(--ink)}
.detail-identity{display:flex;align-items:flex-start;justify-content:space-between;gap:28px}.identity-main{display:flex;min-width:0;align-items:flex-start;gap:13px}.identity-icon,.scope-icon{display:grid;flex:0 0 auto;place-items:center;border:1px solid var(--line);background:var(--surface);color:var(--ink)}.identity-icon{width:42px;height:42px;border-radius:10px}.identity-main h1{margin:0;font-size:24px;line-height:1.2;letter-spacing:-.03em}.identity-main p{margin:5px 0 0;color:var(--muted);font-size:13px}.identity-main small{display:block;margin-top:7px;color:var(--muted);font-family:var(--font-mono,ui-monospace,monospace);font-size:10px}.identity-state{display:flex;align-items:center;gap:12px;font-size:12px}.state-label{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}.state-label i{width:7px;height:7px;border-radius:50%;background:#b5bcc5}.state-label i.active{background:#3a8b68}
.locked-note{margin:0;padding:11px 14px;border-left:2px solid #b8873f;background:#fffaf1;color:#795c2d;font-size:12px}.detail-section{display:grid;gap:14px;padding-top:26px;border-top:1px solid var(--line)}.detail-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.detail-section-head h2{margin:0;font-size:16px;letter-spacing:-.02em}.detail-section-head p{margin:6px 0 0;color:var(--muted);font-size:12px}.detail-section-head :deep(.el-button){display:inline-flex;align-items:center;gap:6px;margin-left:0}
.scope-list{border-top:1px solid var(--line)}.scope-row{display:grid;grid-template-columns:36px minmax(0,1fr) auto auto auto;min-height:62px;align-items:center;gap:12px;padding:9px 6px;border-bottom:1px solid var(--line)}.scope-icon{width:34px;height:34px;border-radius:9px}.scope-copy{display:flex;min-width:0;flex-direction:column;gap:4px}.scope-copy strong{overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.scope-copy small,.scope-state{color:var(--muted);font-size:11px}.scope-state{white-space:nowrap}.empty-line{margin:0;padding:18px 4px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:12px}
@keyframes detail-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:720px){.detail-identity,.detail-section-head{align-items:stretch;flex-direction:column}.identity-state{justify-content:space-between}.scope-row{grid-template-columns:34px minmax(0,1fr) auto}.scope-state{grid-column:2}.scope-row>.el-switch{grid-column:3;grid-row:1/3}.scope-row>.el-button{grid-column:2;justify-self:start}}
@media(max-width:480px){.scope-row{grid-template-columns:34px minmax(0,1fr)}.scope-row>.el-switch{grid-column:2;grid-row:auto;justify-self:start}.scope-row>.el-button{grid-column:2}.identity-state{align-items:center;flex-wrap:wrap}}
@media(prefers-reduced-motion:reduce){.tool-detail{animation:none}}
</style>
