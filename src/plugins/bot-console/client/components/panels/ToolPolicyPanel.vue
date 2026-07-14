<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import ToggleCard from '../ToggleCard.vue'
import { useToast } from '../../composables/useToast'
import {
  FILE_SYSTEM_CONTROL_KEYS,
  normalizeBoolean,
  type useBotConsole,
} from '../../composables/useBotConsole'
import {
  getToolCategoryLabel,
  getToolCompatibilityLabel,
  getToolRiskLabel,
  getToolRouteLabel,
  getToolScopeLabel,
  getToolScopeMeta,
} from '../../composables/toolPolicy'
import { formatErrorMessage } from '../../utils/format'
import { getFieldHint, getFieldLabel } from '../../utils/constants'
import type {
  ToolCatalogEntry,
  ToolPolicyScope,
  ToolOverrideMode,
  ToolRouteProfile,
} from '../../types'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const {
  toolRouteProfile,
  selectedToolScopeKey,
  toolPolicyScopes,
  toolPolicyCatalog,
  toolPolicyRouteProfiles,
  selectedToolScope,
  selectedToolScopeLabel,
  selectedToolRouteLabel,
  changedToolOverrideKeys,
  envDraft,
  changedKeys,
  canSaveAllSettings,
} = bc

const expandedScopeSections = ref<Record<string, boolean>>({
  default: false,
  group: false,
  private: false,
})

const expandedToolCards = ref<Record<string, boolean>>({})

const selectedToolScopeMeta = computed(() => {
  const scope = selectedToolScope.value
  return scope ? getToolScopeMeta(scope) : '暂无可用作用域'
})

const activeScope = computed(() => selectedToolScope.value ?? toolPolicyScopes.value[0] ?? null)

const selectedToolScopeSummary = computed(() => {
  const scope = activeScope.value
  if (!scope) return '当前没有可编辑的会话范围'
  const enabled = countEnabledToolsForScope(scope, toolRouteProfile.value)
  const registeredCount = toolPolicyCatalog.value.filter(tool => tool.registered !== false).length
  const unregisteredCount = toolPolicyCatalog.value.length - registeredCount
  if (unregisteredCount > 0) {
    return `${enabled} / ${registeredCount} 已启用 · ${unregisteredCount} 未注册`
  }
  return `${enabled} / ${registeredCount} 已启用`
})

const validationErrors = computed(() => bc.validateToolPolicyDraft())

const routeHint = computed(() => {
  if (toolRouteProfile.value === 'automation') {
    return '自动化链路当前通常不会消费工具，这里主要用于预留和未来接入。'
  }
  return '直答是当前真实主链路。这里的设置会直接影响 Reply V2 的工具暴露面。'
})

const defaultScopes = computed(() =>
  toolPolicyScopes.value.filter(scope => scope.scopeKind === 'global_default' || scope.scopeKind === 'private_default'),
)

const groupScopes = computed(() => toolPolicyScopes.value.filter(scope => scope.scopeKind === 'group'))
const privateConversationScopes = computed(() =>
  toolPolicyScopes.value.filter(scope => scope.scopeKind === 'private_conversation'),
)

const groupedTools = computed(() => {
  const groups: Array<{ key: string; label: string; tools: ToolCatalogEntry[] }> = []
  const order: ToolCatalogEntry['category'][] = ['builtin', 'file', 'web', 'geo']
  for (const category of order) {
    const tools = toolPolicyCatalog.value.filter(tool => tool.category === category)
    if (!tools.length) continue
    groups.push({
      key: category,
      label: getToolCategoryLabel(category),
      tools,
    })
  }
  return groups
})

const fileSystemTools = computed(() =>
  toolPolicyCatalog.value.filter(tool => tool.category === 'file'),
)

const fileSystemConfigChangedKeys = computed(() =>
  FILE_SYSTEM_CONTROL_KEYS.filter(key => changedKeys.value.has(key)),
)

const canSaveFileSystemConfig = computed(() => fileSystemConfigChangedKeys.value.length > 0)
const hasPendingChanges = computed(() => changedToolOverrideKeys.value.size > 0 || canSaveFileSystemConfig.value)

const fileSystemCapabilityEnabled = computed({
  get: () => normalizeBoolean(envDraft.CHATLUNA_COMMON_FS),
  set: (enabled: boolean) => {
    envDraft.CHATLUNA_COMMON_FS = enabled ? 'true' : 'false'
  },
})

const fileSystemScopeSummary = computed(() =>
  (envDraft.CHATLUNA_COMMON_FS_SCOPE_PATH ?? '').trim() || '留空，跟随 Koishi 启动目录',
)

const fileSystemAllowedGroupsSummary = computed(() =>
  (envDraft.CHATLUNA_COMMON_FS_ALLOWED_GROUPS ?? '').trim() || '留空，群聊不暴露文件系统工具',
)

function scopeKey(scope: Pick<ToolPolicyScope, 'scopeKind' | 'scopeId'>): string {
  return `${scope.scopeKind}:${scope.scopeId}`
}

function isSelectedScope(scope: ToolPolicyScope): boolean {
  return scopeKey(scope) === selectedToolScopeKey.value
}

function selectScope(scope: ToolPolicyScope) {
  bc.selectToolPolicyScope(scope)
}

function isScopeSectionExpanded(key: string): boolean {
  return expandedScopeSections.value[key] ?? false
}

function toggleScopeSection(key: string): void {
  expandedScopeSections.value = {
    ...expandedScopeSections.value,
    [key]: !isScopeSectionExpanded(key),
  }
}

function setRoute(route: ToolRouteProfile) {
  bc.setToolRouteProfile(route)
}

function modeLabel(mode: ToolOverrideMode): string {
  if (mode === 'enabled') return '启用'
  if (mode === 'disabled') return '禁用'
  return '继承'
}

function resolveMode(scope: ToolPolicyScope, toolName: string): ToolOverrideMode {
  return bc.getToolOverrideMode(scope, toolRouteProfile.value, toolName)
}

function resolveSelectedMode(toolName: string): ToolOverrideMode {
  const scope = activeScope.value
  if (!scope) return 'inherit'
  return resolveMode(scope, toolName)
}

function updateMode(scope: ToolPolicyScope, toolName: string, mode: ToolOverrideMode): void {
  bc.setToolOverrideMode(scope, toolRouteProfile.value, toolName, mode)
}

function updateSelectedMode(toolName: string, mode: ToolOverrideMode): void {
  const scope = activeScope.value
  if (!scope) return
  updateMode(scope, toolName, mode)
}

function countEnabledToolsForScope(scope: ToolPolicyScope, route: ToolRouteProfile): number {
  return toolPolicyCatalog.value.filter(tool => bc.resolveEffectiveToolEnabled(scope, route, tool.toolName)).length
}

function countEnabledToolsForRoute(route: ToolRouteProfile): number {
  return toolPolicyScopes.value.reduce(
    (total, scope) => total + toolPolicyCatalog.value.filter(tool => bc.resolveEffectiveToolEnabled(scope, route, tool.toolName)).length,
    0,
  )
}

function countEnabledToolsForGroup(groupTools: ToolCatalogEntry[]): number {
  const scope = activeScope.value
  if (!scope) return 0
  return groupTools.filter(tool => bc.resolveEffectiveToolEnabled(scope, toolRouteProfile.value, tool.toolName)).length
}

function setGroupMode(groupTools: ToolCatalogEntry[], mode: Extract<ToolOverrideMode, 'enabled' | 'disabled'>): void {
  const scope = activeScope.value
  if (!scope) return
  for (const tool of groupTools) {
    updateMode(scope, tool.toolName, mode)
  }
}

function toolCardKey(toolName: string): string {
  const scope = activeScope.value
  return `${scope?.scopeKind ?? 'none'}:${scope?.scopeId ?? 'none'}:${toolRouteProfile.value}:${toolName}`
}

function isToolCardExpanded(toolName: string): boolean {
  return expandedToolCards.value[toolCardKey(toolName)] ?? false
}

function toggleToolCard(toolName: string): void {
  const key = toolCardKey(toolName)
  expandedToolCards.value = {
    ...expandedToolCards.value,
    [key]: !isToolCardExpanded(toolName),
  }
}

function summarizeTool(tool: ToolCatalogEntry): string {
  if (tool.registered === false) return '当前运行时未注册，暂时不能下发给模型。'
  return tool.description || tool.compatibilityNote || tool.title
}

function isToolRegistered(tool: ToolCatalogEntry): boolean {
  return tool.registered !== false
}

type ToolVisualState = 'inherit' | 'enabled' | 'disabled' | 'unregistered'

function getToolVisualState(tool: ToolCatalogEntry): ToolVisualState {
  if (!isToolRegistered(tool)) return 'unregistered'
  return resolveSelectedMode(tool.toolName)
}

function getToolVisualStateLabel(tool: ToolCatalogEntry): string {
  const state = getToolVisualState(tool)
  if (state === 'enabled') return '启用'
  if (state === 'disabled') return '禁用'
  if (state === 'unregistered') return '未注册'
  return '继承'
}

function getToolVisualStateBadgeClass(tool: ToolCatalogEntry): string {
  return `bc-badge-tool-state-${getToolVisualState(tool)}`
}

function getToolCardStateClass(tool: ToolCatalogEntry): string {
  return `is-state-${getToolVisualState(tool)}`
}

function getEffectiveStateBadgeClass(tool: ToolCatalogEntry): string {
  if (!isToolRegistered(tool)) return 'bc-badge-tool-state-unregistered'
  return resolveEffectiveStatus(tool.toolName) ? 'bc-badge-tool-state-enabled' : 'bc-badge-tool-state-disabled'
}

async function handleSaveAll(restartAfter: boolean) {
  try {
    if (restartAfter) {
      await bc.saveAllSettingsAndRestart()
      toastAdd('全部配置已保存，正在重启机器人…', 'success')
      return
    }

    const hadGlobalChanges = canSaveFileSystemConfig.value
    const hadToolChanges = changedToolOverrideKeys.value.size > 0

    if (hadGlobalChanges) {
      await bc.saveEnvPatch(FILE_SYSTEM_CONTROL_KEYS)
    }
    if (hadToolChanges) {
      await bc.saveToolOverrides()
    }
    if (hadGlobalChanges && hadToolChanges) {
      toastAdd('工具配置与全局设置已保存', 'success')
      return
    }
    if (hadGlobalChanges) {
      toastAdd('全局工具设置已保存', 'success')
      return
    }
    toastAdd('工具策略已保存', 'success')
  } catch (err: unknown) {
    toastAdd(formatErrorMessage(err, '保存失败'), 'error')
  }
}

async function handleSaveFileSystemConfig(restartAfter: boolean) {
  try {
    if (restartAfter) {
      await bc.saveAllSettingsAndRestart()
      toastAdd('全部配置已保存，正在重启机器人…', 'success')
      return
    }
    await bc.saveEnvPatch(FILE_SYSTEM_CONTROL_KEYS)
    toastAdd('文件系统配置已保存', 'success')
  } catch (err: unknown) {
    toastAdd(formatErrorMessage(err, '文件系统配置保存失败'), 'error')
  }
}

function resolveEffectiveStatus(toolName: string): boolean {
  const scope = activeScope.value
  if (!scope) return false
  return bc.resolveEffectiveToolEnabled(scope, toolRouteProfile.value, toolName)
}

function effectiveStatusLabel(toolName: string): string {
  const scope = activeScope.value
  if (!scope) return '禁用'
  return bc.resolveEffectiveToolStatusLabel(scope, toolRouteProfile.value, toolName)
}
</script>

<template>
  <section class="bc-panel bc-tool-panel">
    <div class="bc-panel-head">
      <div>
        <p class="bc-eyebrow">工具控制</p>
        <h2>工具控制</h2>
        <p class="bc-muted">
          上方管理全局工具环境设置，下方再按会话范围和链路类型管理工具可用性。这里控制的是发给模型的工具列表，不是用户可见消息。
        </p>
      </div>
    </div>

    <section class="bc-tool-global-settings">
      <div class="bc-tool-global-settings-head">
        <div>
          <p class="bc-eyebrow">全局设置</p>
          <h3>全局工具设置</h3>
          <p class="bc-muted">
            这里的配置不跟随左侧群聊、私聊或房间切换，直接作用于整台 bot 的工具运行环境。
          </p>
        </div>
        <span class="bc-badge bc-badge-muted">不按房间划分</span>
      </div>

      <div class="bc-tool-global-settings-grid">
        <article class="bc-tool-card bc-tool-config-card bc-tool-global-config-card">
          <div class="bc-tool-card-head">
            <div class="bc-tool-card-title">
              <strong>文件系统总控</strong>
              <span class="bc-badge bc-badge-sm bc-badge-muted">环境配置</span>
            </div>
            <div class="bc-tool-card-badges">
              <span
                class="bc-badge bc-badge-sm"
                :class="fileSystemCapabilityEnabled ? 'bc-badge-success' : 'bc-badge-danger'"
              >
                {{ fileSystemCapabilityEnabled ? '全局已开启' : '全局已关闭' }}
              </span>
              <span class="bc-badge bc-badge-sm bc-badge-warning">重启生效</span>
            </div>
          </div>

          <p class="bc-tool-card-desc">
            控制是否向 ChatLuna 注入整组文件系统工具和 bash，并设置它们的默认工作目录与群聊白名单。
          </p>
          <p class="bc-tool-card-note">
            这张卡是进程级配置，不受左侧作用域切换影响；当前模式下 bash 以宿主机高权限运行且允许联网，这里的目录只作为默认工作目录展示，不构成强隔离边界。
          </p>

          <ToggleCard
            v-model="fileSystemCapabilityEnabled"
            :label="getFieldLabel('CHATLUNA_COMMON_FS')"
            :is-dirty="changedKeys.has('CHATLUNA_COMMON_FS')"
          />

          <label class="bc-field bc-tool-config-field">
            <span class="bc-field-label">
              {{ getFieldLabel('CHATLUNA_COMMON_FS_SCOPE_PATH') }}
              <span
                v-if="getFieldHint('CHATLUNA_COMMON_FS_SCOPE_PATH')"
                class="bc-field-help"
                tabindex="0"
                role="note"
                :aria-label="getFieldHint('CHATLUNA_COMMON_FS_SCOPE_PATH')"
              >
                <span aria-hidden="true">!</span>
                <span class="bc-field-tooltip" role="tooltip">{{ getFieldHint('CHATLUNA_COMMON_FS_SCOPE_PATH') }}</span>
              </span>
              <span
                v-if="changedKeys.has('CHATLUNA_COMMON_FS_SCOPE_PATH')"
                class="bc-field-modified"
              >已修改</span>
            </span>
            <input
              :value="envDraft.CHATLUNA_COMMON_FS_SCOPE_PATH ?? ''"
              type="text"
              spellcheck="false"
              placeholder="~/system"
              @input="(e) => { envDraft.CHATLUNA_COMMON_FS_SCOPE_PATH = (e.target as HTMLInputElement).value }"
            />
            <em class="bc-field-note">
              留空时跟随 Koishi 启动目录；支持填写 ~/...。当前高权限模式下，该目录仅作为默认工作目录，不会阻止 bash 访问宿主机其他路径。
            </em>
          </label>

          <label class="bc-field bc-tool-config-field">
            <span class="bc-field-label">
              {{ getFieldLabel('CHATLUNA_COMMON_FS_ALLOWED_GROUPS') }}
              <span
                v-if="getFieldHint('CHATLUNA_COMMON_FS_ALLOWED_GROUPS')"
                class="bc-field-help"
                tabindex="0"
                role="note"
                :aria-label="getFieldHint('CHATLUNA_COMMON_FS_ALLOWED_GROUPS')"
              >
                <span aria-hidden="true">!</span>
                <span class="bc-field-tooltip" role="tooltip">{{ getFieldHint('CHATLUNA_COMMON_FS_ALLOWED_GROUPS') }}</span>
              </span>
              <span
                v-if="changedKeys.has('CHATLUNA_COMMON_FS_ALLOWED_GROUPS')"
                class="bc-field-modified"
              >已修改</span>
            </span>
            <input
              :value="envDraft.CHATLUNA_COMMON_FS_ALLOWED_GROUPS ?? ''"
              type="text"
              spellcheck="false"
              placeholder="829573670,921554872"
              @input="(e) => { envDraft.CHATLUNA_COMMON_FS_ALLOWED_GROUPS = (e.target as HTMLInputElement).value }"
            />
            <em class="bc-field-note">
              非白名单群不会把 file_*、grep、glob、bash 暴露给模型；私聊不受这条群聊白名单限制。
            </em>
          </label>

          <div class="bc-tool-card-meta bc-tool-card-meta-stack">
            <span>当前作用域</span>
            <div class="bc-tool-card-tags">
              <span class="bc-badge bc-badge-sm bc-badge-muted">{{ fileSystemScopeSummary }}</span>
            </div>
          </div>

          <div class="bc-tool-card-meta bc-tool-card-meta-stack">
            <span>群聊白名单</span>
            <div class="bc-tool-card-tags">
              <span class="bc-badge bc-badge-sm bc-badge-muted">{{ fileSystemAllowedGroupsSummary }}</span>
            </div>
          </div>

          <div class="bc-tool-card-meta bc-tool-card-meta-stack">
            <span>影响工具</span>
            <div class="bc-tool-card-tags">
              <span
                v-for="tool in fileSystemTools"
                :key="`fs-config-${tool.toolName}`"
                class="bc-badge bc-badge-sm bc-badge-muted"
              >
                {{ tool.toolName }}
              </span>
            </div>
          </div>

          <div class="bc-tool-card-foot bc-tool-config-actions">
            <span class="bc-tool-card-current">
              配置：{{ fileSystemConfigChangedKeys.length ? `${fileSystemConfigChangedKeys.length} 项待保存` : '未修改' }} · 生效：需重启机器人
            </span>
            <div class="bc-tool-config-action-row">
              <button
                type="button"
                class="bc-btn bc-btn-sm bc-btn-ghost"
                :disabled="!canSaveFileSystemConfig"
                @click="handleSaveFileSystemConfig(false)"
              >
                仅保存
              </button>
              <button
                type="button"
                class="bc-btn bc-btn-sm bc-btn-primary"
                :disabled="!canSaveAllSettings"
                @click="handleSaveFileSystemConfig(true)"
              >
                保存全部并重启
              </button>
            </div>
          </div>
        </article>
      </div>
    </section>

    <div class="bc-tool-routebar">
      <div class="bc-tool-route-switch" role="tablist" aria-label="链路类型">
        <button
          v-for="route in toolPolicyRouteProfiles"
          :key="route"
          class="bc-tool-route-pill"
          :class="{ 'is-active': toolRouteProfile === route }"
          type="button"
          @click="setRoute(route)"
        >
          <span>{{ getToolRouteLabel(route) }}</span>
          <span class="bc-tool-route-count">{{ countEnabledToolsForRoute(route) }} 启用</span>
        </button>
      </div>
      <p class="bc-muted bc-tool-route-note">
        {{ routeHint }}
      </p>
    </div>

    <div class="bc-tool-scope-banner">
      <div>
        <p class="bc-eyebrow">会话范围</p>
        <h3>按会话范围的工具策略</h3>
        <p class="bc-muted">
          左侧群聊、私聊和默认策略只影响这里的工具暴露规则，不会改动上方的全局工具环境设置。
        </p>
      </div>
    </div>

    <div class="bc-tool-layout">
      <aside class="bc-tool-sidebar">
        <div class="bc-tool-scope-stack">
          <button
            type="button"
            class="bc-tool-scope-stack-toggle"
            :class="{ 'is-expanded': isScopeSectionExpanded('default') }"
            @click="toggleScopeSection('default')"
          >
            <span class="bc-tool-scope-stack-toggle-main">
              <strong>默认策略</strong>
              <span class="bc-badge bc-badge-muted">优先级最高的兜底层</span>
            </span>
            <span class="bc-tool-scope-stack-toggle-icon">{{ isScopeSectionExpanded('default') ? '收起' : '展开' }}</span>
          </button>
          <div
            v-show="isScopeSectionExpanded('default')"
            class="bc-tool-scope-dropdown"
          >
            <button
              v-for="scope in defaultScopes"
              :key="scopeKey(scope)"
              type="button"
              class="bc-tool-scope-card"
              :class="{ 'is-active': isSelectedScope(scope) }"
              @click="selectScope(scope)"
            >
              <div class="bc-tool-scope-card-head">
                <strong>{{ getToolScopeLabel(scope) }}</strong>
                <span class="bc-badge bc-badge-sm bc-badge-muted">{{ countEnabledToolsForScope(scope, toolRouteProfile) }} 启用</span>
              </div>
              <p>{{ getToolScopeMeta(scope) }}</p>
            </button>
          </div>
        </div>

        <div class="bc-tool-scope-stack">
          <button
            type="button"
            class="bc-tool-scope-stack-toggle"
            :class="{ 'is-expanded': isScopeSectionExpanded('group') }"
            @click="toggleScopeSection('group')"
          >
            <span class="bc-tool-scope-stack-toggle-main">
              <strong>群聊</strong>
              <span class="bc-badge bc-badge-muted">{{ groupScopes.length }} 个</span>
            </span>
            <span class="bc-tool-scope-stack-toggle-icon">{{ isScopeSectionExpanded('group') ? '收起' : '展开' }}</span>
          </button>
          <div
            v-show="isScopeSectionExpanded('group')"
            class="bc-tool-scope-dropdown"
          >
            <button
              v-for="scope in groupScopes"
              :key="scopeKey(scope)"
              type="button"
              class="bc-tool-scope-card"
              :class="{ 'is-active': isSelectedScope(scope) }"
              @click="selectScope(scope)"
            >
              <div class="bc-tool-scope-card-head">
                <strong>{{ getToolScopeLabel(scope) }}</strong>
                <span class="bc-badge bc-badge-sm bc-badge-muted">{{ countEnabledToolsForScope(scope, toolRouteProfile) }} 启用</span>
              </div>
              <p>{{ getToolScopeMeta(scope) }}</p>
            </button>
          </div>
        </div>

        <div class="bc-tool-scope-stack">
          <button
            type="button"
            class="bc-tool-scope-stack-toggle"
            :class="{ 'is-expanded': isScopeSectionExpanded('private') }"
            @click="toggleScopeSection('private')"
          >
            <span class="bc-tool-scope-stack-toggle-main">
              <strong>私聊</strong>
              <span class="bc-badge bc-badge-muted">{{ privateConversationScopes.length }} 个</span>
            </span>
            <span class="bc-tool-scope-stack-toggle-icon">{{ isScopeSectionExpanded('private') ? '收起' : '展开' }}</span>
          </button>
          <div
            v-show="isScopeSectionExpanded('private')"
            class="bc-tool-scope-dropdown"
          >
            <button
              v-for="scope in privateConversationScopes"
              :key="scopeKey(scope)"
              type="button"
              class="bc-tool-scope-card"
              :class="{ 'is-active': isSelectedScope(scope) }"
              @click="selectScope(scope)"
            >
              <div class="bc-tool-scope-card-head">
                <strong>{{ getToolScopeLabel(scope) }}</strong>
                <span class="bc-badge bc-badge-sm bc-badge-muted">{{ countEnabledToolsForScope(scope, toolRouteProfile) }} 启用</span>
              </div>
              <p>{{ getToolScopeMeta(scope) }}</p>
            </button>
          </div>
        </div>
      </aside>

      <div class="bc-tool-board">
        <div class="bc-tool-board-head">
          <div>
            <h3>{{ selectedToolScopeLabel }}</h3>
            <p class="bc-muted">{{ selectedToolScopeMeta }} · 当前链路 {{ selectedToolRouteLabel }}</p>
          </div>
          <span class="bc-badge bc-badge-primary">{{ selectedToolScopeSummary }}</span>
        </div>

        <div
          v-if="validationErrors.length"
          class="bc-tool-warning"
        >
          <strong>当前配置有依赖冲突</strong>
          <p
            v-for="error in validationErrors"
            :key="error"
          >
            {{ error }}
          </p>
        </div>

        <section
          v-for="group in groupedTools"
          :key="group.key"
          class="bc-tool-group"
        >
          <div class="bc-tool-group-head">
            <div class="bc-tool-group-head-main">
              <strong>{{ group.label }}</strong>
              <span class="bc-badge bc-badge-muted">{{ group.tools.length }} 个工具</span>
              <span class="bc-badge bc-badge-primary">{{ countEnabledToolsForGroup(group.tools) }} 启用</span>
            </div>
            <div class="bc-tool-group-actions">
              <button
                type="button"
                class="bc-btn bc-btn-sm"
                :disabled="!activeScope"
                @click.stop="setGroupMode(group.tools, 'enabled')"
              >
                全部启用
              </button>
              <button
                type="button"
                class="bc-btn bc-btn-sm bc-btn-ghost"
                :disabled="!activeScope"
                @click.stop="setGroupMode(group.tools, 'disabled')"
              >
                全部禁用
              </button>
            </div>
          </div>

          <div class="bc-tool-card-grid">
            <article
              v-for="tool in group.tools"
              :key="tool.toolName"
              class="bc-tool-card"
              :class="[getToolCardStateClass(tool), { 'is-expanded': isToolCardExpanded(tool.toolName) }]"
            >
              <div class="bc-tool-card-head bc-tool-card-summary">
                <button
                  type="button"
                  class="bc-tool-card-summary-main"
                  @click="toggleToolCard(tool.toolName)"
                >
                  <span class="bc-tool-card-title">
                    <strong>{{ tool.title }}</strong>
                    <span class="bc-badge bc-badge-sm bc-badge-muted">{{ tool.toolName }}</span>
                    <span
                      class="bc-badge bc-badge-sm"
                      :class="getToolVisualStateBadgeClass(tool)"
                    >
                      {{ getToolVisualStateLabel(tool) }}
                    </span>
                  </span>
                  <span class="bc-tool-card-summary-text">{{ summarizeTool(tool) }}</span>
                </button>

                <div class="bc-tool-card-summary-controls">
                  <div class="bc-tool-mode-row bc-tool-mode-row-compact" role="group" :aria-label="`${tool.title} 可用性`">
                    <button
                      type="button"
                      class="bc-tool-mode-button"
                      :class="{
                        'is-active': resolveSelectedMode(tool.toolName) === 'inherit',
                        'is-inherit': resolveSelectedMode(tool.toolName) === 'inherit',
                      }"
                      :disabled="!isToolRegistered(tool)"
                      @click.stop="updateSelectedMode(tool.toolName, 'inherit')"
                    >
                      继承
                    </button>
                    <button
                      type="button"
                      class="bc-tool-mode-button"
                      :class="{
                        'is-active': resolveSelectedMode(tool.toolName) === 'enabled',
                        'is-enabled': resolveSelectedMode(tool.toolName) === 'enabled',
                      }"
                      :disabled="!isToolRegistered(tool)"
                      @click.stop="updateSelectedMode(tool.toolName, 'enabled')"
                    >
                      启用
                    </button>
                    <button
                      type="button"
                      class="bc-tool-mode-button"
                      :class="{
                        'is-active': resolveSelectedMode(tool.toolName) === 'disabled',
                        'is-disabled': resolveSelectedMode(tool.toolName) === 'disabled',
                      }"
                      :disabled="!isToolRegistered(tool)"
                      @click.stop="updateSelectedMode(tool.toolName, 'disabled')"
                    >
                      禁用
                    </button>
                  </div>

                  <button
                    type="button"
                    class="bc-tool-card-toggle"
                    @click="toggleToolCard(tool.toolName)"
                  >
                    {{ isToolCardExpanded(tool.toolName) ? '收起' : '展开' }}
                  </button>
                </div>
              </div>

              <div
                v-if="isToolCardExpanded(tool.toolName)"
                class="bc-tool-card-detail"
              >
                <div class="bc-tool-card-badges">
                  <span class="bc-badge bc-badge-sm bc-badge-muted">
                    {{ getToolCompatibilityLabel(tool.compatibility) }}
                  </span>
                  <span class="bc-badge bc-badge-sm bc-badge-muted">{{ getToolRiskLabel(tool.riskLevel) }}</span>
                  <span
                    class="bc-badge bc-badge-sm"
                    :class="getToolVisualStateBadgeClass(tool)"
                  >
                    {{ getToolVisualStateLabel(tool) }}
                  </span>
                </div>

                <p class="bc-tool-card-desc">{{ tool.description }}</p>
                <p class="bc-tool-card-note">{{ tool.compatibilityNote }}</p>
                <p
                  v-if="!isToolRegistered(tool)"
                  class="bc-tool-card-note"
                >
                  这个工具在目录里存在，但当前 Koishi 运行时没有注册它。`tool-policy` 只能控制已注册工具，不能把缺失的 runtime 工具凭空打开。
                </p>

                <div class="bc-tool-card-meta">
                  <span>适用链路</span>
                  <div class="bc-tool-route-tags">
                    <span
                      v-for="route in tool.availableRoutes"
                      :key="route"
                      class="bc-badge bc-badge-sm"
                      :class="{ 'bc-badge-primary': route === toolRouteProfile }"
                    >
                      {{ getToolRouteLabel(route) }}
                    </span>
                  </div>
                </div>

                <div class="bc-tool-card-meta bc-tool-card-meta-stack">
                  <span>关联工具</span>
                  <div class="bc-tool-card-tags">
                    <span
                      v-for="related in tool.relatedTools.length ? tool.relatedTools : ['无']"
                      :key="related"
                      class="bc-badge bc-badge-sm bc-badge-muted"
                    >
                      {{ related }}
                    </span>
                  </div>
                </div>

                <div
                  v-if="tool.hardDependencies.length"
                  class="bc-tool-card-meta bc-tool-card-meta-stack"
                >
                  <span>依赖</span>
                  <div class="bc-tool-card-tags">
                    <span
                      v-for="dependency in tool.hardDependencies"
                      :key="dependency"
                      class="bc-badge bc-badge-sm bc-badge-warning"
                    >
                      {{ dependency }}
                    </span>
                  </div>
                </div>
              </div>

              <div class="bc-tool-card-foot">
                <span class="bc-tool-card-current">
                  配置：{{ modeLabel(resolveSelectedMode(tool.toolName)) }} · 生效：{{ effectiveStatusLabel(tool.toolName) }}
                </span>
                <span
                  class="bc-badge bc-badge-sm"
                  :class="getEffectiveStateBadgeClass(tool)"
                >
                  {{ !isToolRegistered(tool) ? '未下发' : resolveEffectiveStatus(tool.toolName) ? '已启用' : '已禁用' }}
                </span>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>

    <transition name="bc-fab">
      <div
        v-if="hasPendingChanges"
        class="bc-tool-fab"
      >
        <div class="bc-tool-fab-status">
          <strong>{{ changedToolOverrideKeys.size + fileSystemConfigChangedKeys.length }} 项待保存</strong>
          <span>保存并重启会同时提交其他页面的待保存修改。</span>
        </div>
        <div class="bc-tool-fab-actions">
          <button
            type="button"
            class="bc-btn bc-btn-sm bc-btn-ghost"
            @click="handleSaveAll(false)"
          >
            保存
          </button>
          <button
            type="button"
            class="bc-btn bc-btn-sm bc-btn-primary"
            :disabled="!canSaveAllSettings"
            @click="handleSaveAll(true)"
          >
            保存全部并重启
          </button>
        </div>
      </div>
    </transition>
  </section>
</template>
