<script setup lang="ts">
import { computed, inject, reactive, ref } from 'vue'
import { useToast } from '../../composables/useToast'
import {
  FEATURE_KEYS,
  FEATURE_NUMBER_KEYS,
  FEATURE_TEXT_KEYS,
  normalizeBoolean,
  type FeatureOverrideMode,
} from '../../composables/useBotConsole'
import { getFieldHint, getFieldLabel } from '../../utils/constants'
import { formatErrorMessage } from '../../utils/format'
import type { useBotConsole } from '../../composables/useBotConsole'
import type { ConsoleFeatureScope, ConversationTarget, ScopedFeatureKey } from '../../types'
import InlineConfirm from '../InlineConfirm.vue'
import ToggleCard from '../ToggleCard.vue'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const {
  botState,
  envDraft,
  changedKeys,
  changedFeatureEnvKeys,
  canSaveFeatureSettings,
  changedFeatureOverrideKeys,
  featureOverrideDraft,
  conversationPending,
  conversationDeletePending,
} = bc

const featureScopes = computed<ConsoleFeatureScope[]>(() => botState.value?.featureScopes ?? [])
const conversationTargets = computed<ConversationTarget[]>(() => botState.value?.conversationTargets ?? [])
const privateDefaultScope = computed<ConsoleFeatureScope | null>(
  () => featureScopes.value.find(item => item.scopeKind === 'private_default') ?? null,
)
const groupFeatureScopes = computed<ConsoleFeatureScope[]>(
  () => featureScopes.value.filter(item => item.scopeKind === 'group'),
)
const privateConversationTargets = computed<ConversationTarget[]>(
  () => conversationTargets.value.filter(item => item.scopeKind === 'private'),
)
const groupConversationTargets = computed<ConversationTarget[]>(
  () => conversationTargets.value.filter(item => item.scopeKind === 'group'),
)

const privateScopeExpanded = ref(false)
const groupScopesExpanded = ref(false)
const privateTargetsExpanded = ref(false)
const groupTargetsExpanded = ref(false)
const batchPending = ref(false)
const selectedConversationMap = reactive<Record<string, boolean>>({})

function buildOverrideKey(scope: ConsoleFeatureScope, featureKey: ScopedFeatureKey): string {
  return `${scope.scopeKind}:${scope.scopeId}:${featureKey}`
}

function isPrivateUnsupported(scope: ConsoleFeatureScope, featureKey: ScopedFeatureKey): boolean {
  return scope.scopeKind === 'private_default'
    && (featureKey === 'CHAT_NATURAL_TRIGGER_ENABLED' || featureKey === 'QQBOT_REALTIME_MESSAGE_ENABLED')
}

function getScopeOverrideMode(scope: ConsoleFeatureScope, featureKey: ScopedFeatureKey): FeatureOverrideMode {
  return featureOverrideDraft[buildOverrideKey(scope, featureKey)] ?? 'inherit'
}

function setScopeOverrideMode(scope: ConsoleFeatureScope, featureKey: ScopedFeatureKey, value: string): void {
  featureOverrideDraft[buildOverrideKey(scope, featureKey)] = value as FeatureOverrideMode
}

function isScopeOverrideDirty(scope: ConsoleFeatureScope, featureKey: ScopedFeatureKey): boolean {
  const key = buildOverrideKey(scope, featureKey)
  return changedFeatureOverrideKeys.value.has(key)
}

function resolveEffectiveEnabled(scope: ConsoleFeatureScope, featureKey: ScopedFeatureKey): boolean {
  const mode = getScopeOverrideMode(scope, featureKey)
  if (mode === 'enabled') return true
  if (mode === 'disabled') return false
  return normalizeBoolean(envDraft[featureKey])
}

function buildInheritLabel(scope: ConsoleFeatureScope, featureKey: ScopedFeatureKey): string {
  return `跟随默认（当前${resolveEffectiveEnabled(scope, featureKey) ? '开启' : '关闭'}）`
}

function formatScopeMeta(scope: ConsoleFeatureScope): string {
  if (scope.scopeKind === 'private_default') {
    return '统一作用于所有私聊会话。'
  }
  return `群号 ${scope.scopeId}${scope.roomId ? ` · 房间 #${scope.roomId}` : ''}`
}

function formatTargetMeta(target: ConversationTarget): string {
  return target.scopeKind === 'private'
    ? `私聊房间 #${target.roomId}`
    : `群号 ${target.scopeId} · 房间 #${target.roomId}`
}

function getScopeSectionTitle(kind: 'private' | 'group'): string {
  return kind === 'private' ? '私聊房间' : '群聊房间'
}

function isConversationSelected(target: ConversationTarget): boolean {
  return selectedConversationMap[target.conversationId] === true
}

function setConversationSelected(target: ConversationTarget, selected: boolean): void {
  if (selected) {
    selectedConversationMap[target.conversationId] = true
  } else {
    delete selectedConversationMap[target.conversationId]
  }
}

function countSelectedTargets(targets: ConversationTarget[]): number {
  return targets.filter(target => isConversationSelected(target)).length
}

function hasAnyPendingTarget(targets: ConversationTarget[]): boolean {
  return targets.some(target =>
    conversationPending[target.conversationId] || conversationDeletePending[target.conversationId],
  )
}

function isConversationBusy(target: ConversationTarget): boolean {
  return conversationPending[target.conversationId] || conversationDeletePending[target.conversationId] || batchPending.value
}

function areAllTargetsSelected(targets: ConversationTarget[]): boolean {
  return targets.length > 0 && targets.every(target => isConversationSelected(target))
}

function selectAllTargets(targets: ConversationTarget[]): void {
  for (const target of targets) {
    setConversationSelected(target, true)
  }
}

function clearTargetSelection(targets: ConversationTarget[]): void {
  for (const target of targets) {
    setConversationSelected(target, false)
  }
}

function getSelectedTargets(targets: ConversationTarget[]): ConversationTarget[] {
  return targets.filter(target => isConversationSelected(target))
}

async function handleSave() {
  try {
    await bc.saveFeatureSettings()
    toastAdd('功能配置已保存', 'success')
  } catch (e: unknown) {
    toastAdd(formatErrorMessage(e, '保存失败'), 'error')
  }
}

async function handleClearConversation(target: ConversationTarget) {
  try {
    const result = await bc.clearConversationHistory(target)
    setConversationSelected(target, false)
    toastAdd(`已清空会话历史，删除 ${result.result.deletedMessages} 条消息`, 'success')
  } catch (e: unknown) {
    toastAdd(e instanceof Error ? e.message : '清理失败', 'error')
  }
}

async function handleBatchClear(targets: ConversationTarget[]) {
  const selectedTargets = getSelectedTargets(targets)
  if (!selectedTargets.length) return

  batchPending.value = true
  let clearedCount = 0
  let deletedMessages = 0
  const failedTargets: string[] = []

  try {
    for (const target of selectedTargets) {
      try {
        const result = await bc.clearConversationHistory(target)
        setConversationSelected(target, false)
        clearedCount += 1
        deletedMessages += result.result.deletedMessages
      } catch (error: unknown) {
        failedTargets.push(error instanceof Error ? `${target.roomName}：${error.message}` : target.roomName)
      }
    }
  } finally {
    batchPending.value = false
  }

  if (failedTargets.length === 0) {
    toastAdd(`已批量清空 ${clearedCount} 个房间，共删除 ${deletedMessages} 条消息`, 'success')
    return
  }

  if (clearedCount > 0) {
    toastAdd(`已清空 ${clearedCount} 个房间，共删除 ${deletedMessages} 条消息；${failedTargets.length} 个失败`, 'warning', 4500)
    return
  }

  toastAdd(`批量清理失败：${failedTargets[0]}`, 'error', 4500)
}

async function handleDeleteConversationRoom(target: ConversationTarget) {
  try {
    const result = await bc.deleteConversationRoom(target)
    setConversationSelected(target, false)
    toastAdd(`已删除房间，清除 ${result.result.deletedMessages} 条消息`, 'success')
  } catch (e: unknown) {
    toastAdd(e instanceof Error ? e.message : '删除失败', 'error')
  }
}

async function handleBatchDelete(targets: ConversationTarget[]) {
  const selectedTargets = getSelectedTargets(targets)
  if (!selectedTargets.length) return

  batchPending.value = true
  let deletedCount = 0
  let deletedMessages = 0
  const failedTargets: string[] = []

  try {
    for (const target of selectedTargets) {
      try {
        const result = await bc.deleteConversationRoom(target)
        setConversationSelected(target, false)
        deletedCount += 1
        deletedMessages += result.result.deletedMessages
      } catch (error: unknown) {
        failedTargets.push(error instanceof Error ? `${target.roomName}：${error.message}` : target.roomName)
      }
    }
  } finally {
    batchPending.value = false
  }

  if (failedTargets.length === 0) {
    toastAdd(`已批量删除 ${deletedCount} 个房间，共清除 ${deletedMessages} 条消息`, 'success')
    return
  }

  if (deletedCount > 0) {
    toastAdd(`已删除 ${deletedCount} 个房间，共清除 ${deletedMessages} 条消息；${failedTargets.length} 个失败`, 'warning', 4500)
    return
  }

  toastAdd(`批量删除失败：${failedTargets[0]}`, 'error', 4500)
}
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>功能开关</h2>
        <p class="bc-muted">全局默认值写入本地环境配置；私聊和群聊房间支持单独覆盖。保存后通常需要重启机器人生效。</p>
      </div>
      <button
        type="button"
        class="bc-btn bc-btn-primary"
        :disabled="!canSaveFeatureSettings"
        @click="handleSave"
      >
        保存配置
      </button>
    </div>

    <div class="bc-panel-subhead">
      <div>
        <strong>全局默认值</strong>
        <p class="bc-muted">作为所有作用域的基础默认值。</p>
      </div>
      <span
        v-if="changedFeatureEnvKeys.size > 0"
        class="bc-badge bc-badge-primary"
      >{{ changedFeatureEnvKeys.size }} 项全局修改</span>
    </div>

    <div class="bc-toggle-grid">
      <ToggleCard
        v-for="key in FEATURE_KEYS"
        :key="key"
        :label="getFieldLabel(key)"
        :model-value="normalizeBoolean(envDraft[key])"
        :is-dirty="changedKeys.has(key)"
        @update:model-value="(value) => { envDraft[key] = String(value) }"
      />
    </div>

    <div
      v-if="FEATURE_TEXT_KEYS.length > 0"
      class="bc-field-grid"
      style="margin-top: 1rem;"
    >
      <label
        v-for="key in FEATURE_TEXT_KEYS"
        :key="key"
        class="bc-field bc-field-span"
      >
        <span class="bc-field-label">
          {{ getFieldLabel(key) }}
          <span
            v-if="getFieldHint(key)"
            class="bc-field-help"
            tabindex="0"
            role="note"
            :aria-label="getFieldHint(key)"
          >
            <span aria-hidden="true">!</span>
            <span class="bc-field-tooltip" role="tooltip">{{ getFieldHint(key) }}</span>
          </span>
          <span
            v-if="changedKeys.has(key)"
            class="bc-field-modified"
          >已修改</span>
        </span>

        <input
          type="text"
          :value="envDraft[key] ?? ''"
          spellcheck="false"
          placeholder="自然触发白名单群，群号之间用英文逗号分隔，如 123456,789012"
          @input="(event) => { envDraft[key] = (event.target as HTMLInputElement).value }"
        />

        <em class="bc-field-note">留空时不会在任何群自动触发；必须明确填写白名单群号。</em>
      </label>
    </div>

    <div
      v-if="FEATURE_NUMBER_KEYS.length > 0"
      class="bc-field-grid"
      style="margin-top: 1rem;"
    >
      <label
        v-for="key in FEATURE_NUMBER_KEYS"
        :key="key"
        class="bc-field"
      >
        <span class="bc-field-label">
          {{ getFieldLabel(key) }}
          <span
            v-if="getFieldHint(key)"
            class="bc-field-help"
            tabindex="0"
            role="note"
            :aria-label="getFieldHint(key)"
          >
            <span aria-hidden="true">!</span>
            <span class="bc-field-tooltip" role="tooltip">{{ getFieldHint(key) }}</span>
          </span>
          <span
            v-if="changedKeys.has(key)"
            class="bc-field-modified"
          >已修改</span>
        </span>

        <input
          type="number"
          :value="envDraft[key] ?? ''"
          min="1"
          step="1"
          @input="(event) => { envDraft[key] = (event.target as HTMLInputElement).value }"
        />
      </label>
    </div>

    <div class="bc-panel-subhead" style="margin-top: 1.25rem;">
      <div>
        <strong>作用域覆盖</strong>
        <p class="bc-muted">作用域卡片使用“跟随默认 / 开启 / 关闭”。私聊不提供群聊自然触发和实时消息。</p>
      </div>
      <span
        v-if="changedFeatureOverrideKeys.size > 0"
        class="bc-badge bc-badge-primary"
      >{{ changedFeatureOverrideKeys.size }} 项覆盖修改</span>
    </div>

    <section
      v-if="privateDefaultScope"
      class="bc-room-section"
    >
      <button
        type="button"
        class="bc-room-section-toggle"
        @click="privateScopeExpanded = !privateScopeExpanded"
      >
        <span class="bc-room-section-title">
          {{ privateDefaultScope.roomName }}
          <span class="bc-badge bc-badge-primary">私聊默认</span>
        </span>
        <span class="bc-room-section-chevron">{{ privateScopeExpanded ? '收起' : '展开' }}</span>
      </button>

      <div
        v-if="privateScopeExpanded"
        class="bc-room-sheet"
      >
        <div class="bc-room-sheet-scroll">
          <div class="bc-feature-scope-list" style="margin-top: 0;">
            <article
              :key="`${privateDefaultScope.scopeKind}:${privateDefaultScope.scopeId}`"
              class="bc-feature-scope-card"
            >
              <div class="bc-feature-scope-head">
                <div>
                  <strong>{{ privateDefaultScope.roomName }}</strong>
                  <p class="bc-muted">{{ formatScopeMeta(privateDefaultScope) }}</p>
                </div>
                <span class="bc-badge bc-badge-primary">私聊默认</span>
              </div>

              <div class="bc-feature-scope-grid">
                <label
                  v-for="featureKey in FEATURE_KEYS"
                  :key="featureKey"
                  class="bc-field"
                >
                  <span class="bc-field-label">
                    {{ getFieldLabel(featureKey) }}
                    <span
                      v-if="isScopeOverrideDirty(privateDefaultScope, featureKey)"
                      class="bc-field-modified"
                    >已修改</span>
                  </span>

                  <template v-if="isPrivateUnsupported(privateDefaultScope, featureKey)">
                    <input
                      type="text"
                      value="私聊不可用"
                      disabled
                    />
                  </template>
                  <template v-else>
                    <select
                      :value="getScopeOverrideMode(privateDefaultScope, featureKey)"
                      @change="setScopeOverrideMode(privateDefaultScope, featureKey, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="inherit">{{ buildInheritLabel(privateDefaultScope, featureKey) }}</option>
                      <option value="enabled">开启</option>
                      <option value="disabled">关闭</option>
                    </select>
                  </template>
                </label>
              </div>
            </article>
          </div>
        </div>
      </div>
    </section>

    <section class="bc-room-section">
      <button
        type="button"
        class="bc-room-section-toggle"
        @click="groupScopesExpanded = !groupScopesExpanded"
      >
        <span class="bc-room-section-title">
          群聊作用域覆盖
          <span class="bc-badge bc-badge-muted">{{ groupFeatureScopes.length }} 个房间</span>
        </span>
        <span class="bc-room-section-chevron">{{ groupScopesExpanded ? '收起' : '展开' }}</span>
      </button>

      <div
        v-if="groupScopesExpanded"
        class="bc-room-sheet"
      >
        <div class="bc-room-sheet-scroll">
          <p
            v-if="groupFeatureScopes.length === 0"
            class="bc-muted"
          >
            当前没有可配置的群聊房间。
          </p>

          <div
            v-else
            class="bc-feature-scope-list"
          >
            <article
              v-for="scope in groupFeatureScopes"
              :key="`${scope.scopeKind}:${scope.scopeId}`"
              class="bc-feature-scope-card"
            >
              <div class="bc-feature-scope-head">
                <div>
                  <strong>{{ scope.roomName }}</strong>
                  <p class="bc-muted">{{ formatScopeMeta(scope) }}</p>
                </div>
                <span class="bc-badge bc-badge-muted">群聊房间</span>
              </div>

              <div class="bc-feature-scope-grid">
                <label
                  v-for="featureKey in FEATURE_KEYS"
                  :key="featureKey"
                  class="bc-field"
                >
                  <span class="bc-field-label">
                    {{ getFieldLabel(featureKey) }}
                    <span
                      v-if="isScopeOverrideDirty(scope, featureKey)"
                      class="bc-field-modified"
                    >已修改</span>
                  </span>

                  <select
                    :value="getScopeOverrideMode(scope, featureKey)"
                    @change="setScopeOverrideMode(scope, featureKey, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="inherit">{{ buildInheritLabel(scope, featureKey) }}</option>
                    <option value="enabled">开启</option>
                    <option value="disabled">关闭</option>
                  </select>
                </label>
              </div>
            </article>
          </div>
        </div>
      </div>
    </section>

    <div class="bc-panel-subhead" style="margin-top: 1.25rem;">
      <div>
        <strong>上下文操作</strong>
        <p class="bc-muted">支持清除会话历史或直接删除房间；两者都不会删除长期记忆。</p>
      </div>
    </div>

    <section class="bc-room-section">
      <button
        type="button"
        class="bc-room-section-toggle"
        @click="privateTargetsExpanded = !privateTargetsExpanded"
      >
        <span class="bc-room-section-title">
          {{ getScopeSectionTitle('private') }}
          <span class="bc-badge bc-badge-muted">{{ privateConversationTargets.length }} 个房间</span>
          <span
            v-if="countSelectedTargets(privateConversationTargets) > 0"
            class="bc-badge bc-badge-primary"
          >已选 {{ countSelectedTargets(privateConversationTargets) }}</span>
        </span>
        <span class="bc-room-section-chevron">{{ privateTargetsExpanded ? '收起' : '展开' }}</span>
      </button>

      <div
        v-if="privateTargetsExpanded"
        class="bc-room-sheet"
      >
        <div class="bc-room-sheet-scroll">
          <div class="bc-room-section-body">
            <div class="bc-room-section-actions">
              <div class="bc-room-section-action-row">
                <button
                  type="button"
                  class="bc-btn bc-btn-sm"
                  :disabled="privateConversationTargets.length === 0 || areAllTargetsSelected(privateConversationTargets)"
                  @click="selectAllTargets(privateConversationTargets)"
                >
                  批量选中本组
                </button>
                <button
                  type="button"
                  class="bc-btn bc-btn-sm bc-btn-ghost"
                  :disabled="countSelectedTargets(privateConversationTargets) === 0"
                  @click="clearTargetSelection(privateConversationTargets)"
                >
                  清空选择
                </button>
              </div>

              <div class="bc-room-section-action-row">
                <InlineConfirm
                  label="批量清除已选"
                  confirm-label="确认批量清除"
                  :disabled="countSelectedTargets(privateConversationTargets) === 0 || hasAnyPendingTarget(getSelectedTargets(privateConversationTargets)) || batchPending"
                  @confirm="handleBatchClear(privateConversationTargets)"
                />
                <InlineConfirm
                  label="批量删除已选"
                  confirm-label="确认批量删除"
                  :disabled="countSelectedTargets(privateConversationTargets) === 0 || hasAnyPendingTarget(getSelectedTargets(privateConversationTargets)) || batchPending"
                  @confirm="handleBatchDelete(privateConversationTargets)"
                />
              </div>
            </div>

            <p
              v-if="privateConversationTargets.length === 0"
              class="bc-muted"
            >
              当前没有可清理的私聊房间。
            </p>

            <div
              v-else
              class="bc-conversation-target-list"
            >
              <article
                v-for="target in privateConversationTargets"
                :key="target.conversationId"
                class="bc-conversation-target-card"
              >
                <label class="bc-target-select">
                  <input
                    type="checkbox"
                    :checked="isConversationSelected(target)"
                    :disabled="isConversationBusy(target)"
                    @change="setConversationSelected(target, ($event.target as HTMLInputElement).checked)"
                  >
                  <span>选中</span>
                </label>

                <div class="bc-conversation-target-main">
                  <div>
                    <strong>{{ target.roomName }}</strong>
                    <p class="bc-muted">{{ formatTargetMeta(target) }}</p>
                    <p class="bc-target-id">conversation: {{ target.conversationId }}</p>
                  </div>

                  <div class="bc-conversation-target-actions">
                    <InlineConfirm
                      label="清除会话历史"
                      confirm-label="确认清除"
                      :disabled="isConversationBusy(target)"
                      @confirm="handleClearConversation(target)"
                    />
                    <InlineConfirm
                      label="删除房间"
                      confirm-label="确认删除"
                      :disabled="isConversationBusy(target)"
                      @confirm="handleDeleteConversationRoom(target)"
                    />
                  </div>
                </div>
              </article>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="bc-room-section">
      <button
        type="button"
        class="bc-room-section-toggle"
        @click="groupTargetsExpanded = !groupTargetsExpanded"
      >
        <span class="bc-room-section-title">
          {{ getScopeSectionTitle('group') }}
          <span class="bc-badge bc-badge-muted">{{ groupConversationTargets.length }} 个房间</span>
          <span
            v-if="countSelectedTargets(groupConversationTargets) > 0"
            class="bc-badge bc-badge-primary"
          >已选 {{ countSelectedTargets(groupConversationTargets) }}</span>
        </span>
        <span class="bc-room-section-chevron">{{ groupTargetsExpanded ? '收起' : '展开' }}</span>
      </button>

      <div
        v-if="groupTargetsExpanded"
        class="bc-room-sheet"
      >
        <div class="bc-room-sheet-scroll">
          <div class="bc-room-section-body">
            <div class="bc-room-section-actions">
              <div class="bc-room-section-action-row">
                <button
                  type="button"
                  class="bc-btn bc-btn-sm"
                  :disabled="groupConversationTargets.length === 0 || areAllTargetsSelected(groupConversationTargets)"
                  @click="selectAllTargets(groupConversationTargets)"
                >
                  批量选中本组
                </button>
                <button
                  type="button"
                  class="bc-btn bc-btn-sm bc-btn-ghost"
                  :disabled="countSelectedTargets(groupConversationTargets) === 0"
                  @click="clearTargetSelection(groupConversationTargets)"
                >
                  清空选择
                </button>
              </div>

              <div class="bc-room-section-action-row">
                <InlineConfirm
                  label="批量清除已选"
                  confirm-label="确认批量清除"
                  :disabled="countSelectedTargets(groupConversationTargets) === 0 || hasAnyPendingTarget(getSelectedTargets(groupConversationTargets)) || batchPending"
                  @confirm="handleBatchClear(groupConversationTargets)"
                />
                <InlineConfirm
                  label="批量删除已选"
                  confirm-label="确认批量删除"
                  :disabled="countSelectedTargets(groupConversationTargets) === 0 || hasAnyPendingTarget(getSelectedTargets(groupConversationTargets)) || batchPending"
                  @confirm="handleBatchDelete(groupConversationTargets)"
                />
              </div>
            </div>

            <p
              v-if="groupConversationTargets.length === 0"
              class="bc-muted"
            >
              当前没有可清理的群聊房间。
            </p>

            <div
              v-else
              class="bc-conversation-target-list"
            >
              <article
                v-for="target in groupConversationTargets"
                :key="target.conversationId"
                class="bc-conversation-target-card"
              >
                <label class="bc-target-select">
                  <input
                    type="checkbox"
                    :checked="isConversationSelected(target)"
                    :disabled="isConversationBusy(target)"
                    @change="setConversationSelected(target, ($event.target as HTMLInputElement).checked)"
                  >
                  <span>选中</span>
                </label>

                <div class="bc-conversation-target-main">
                  <div>
                    <strong>{{ target.roomName }}</strong>
                    <p class="bc-muted">{{ formatTargetMeta(target) }}</p>
                    <p class="bc-target-id">conversation: {{ target.conversationId }}</p>
                  </div>

                  <div class="bc-conversation-target-actions">
                    <InlineConfirm
                      label="清除会话历史"
                      confirm-label="确认清除"
                      :disabled="isConversationBusy(target)"
                      @confirm="handleClearConversation(target)"
                    />
                    <InlineConfirm
                      label="删除房间"
                      confirm-label="确认删除"
                      :disabled="isConversationBusy(target)"
                      @confirm="handleDeleteConversationRoom(target)"
                    />
                  </div>
                </div>
              </article>
            </div>
          </div>
        </div>
      </div>
    </section>
  </section>
</template>
