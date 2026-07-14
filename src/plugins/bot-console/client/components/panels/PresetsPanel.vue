<script setup lang="ts">
import { inject, computed, ref } from 'vue'
import { useToast } from '../../composables/useToast'
import { createEmptyPreset } from '../../composables/useBotConsole'
import { ROLE_LABELS } from '../../utils/constants'
import type { useBotConsole } from '../../composables/useBotConsole'
import type { PresetPrompt } from '../../types'
import InlineConfirm from '../InlineConfirm.vue'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

// Destructure reactive refs for template auto-unwrapping
const { currentPreset, botState, canSavePreset, defaultPreset, envDraft } = bc
const settingDefaultPreset = ref(false)
const presetItems = computed(() => botState.value?.presets ?? [])
const canDeleteCurrentPreset = computed(() => (currentPreset.value.source ?? 'runtime') === 'runtime' && Boolean(currentPreset.value.name))
const currentPresetSourceLabel = computed(() => (currentPreset.value.source ?? 'runtime') === 'bundled' ? '仓库内置' : '运行时')
const draggingPresetName = ref<string | null>(null)
const dropTargetName = ref<string | null>(null)
const dropPosition = ref<'before' | 'after' | null>(null)
const reorderPending = ref(false)
const suppressOpen = ref(false)

// ── Keywords ─────────────────────────────────────────────────────────────────

const keywordsText = computed<string>({
  get: () => currentPreset.value.keywords.join('\n'),
  set: (v: string) => {
    currentPreset.value.keywords = v
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
  },
})

// ── Prompt helpers ────────────────────────────────────────────────────────────

function addPrompt() {
  currentPreset.value.prompts.push({ role: 'system', content: '' })
}

function removePrompt(index: number) {
  currentPreset.value.prompts.splice(index, 1)
  if (!currentPreset.value.prompts.length) {
    currentPreset.value.prompts.push({ role: 'system', content: '' })
  }
}

function updatePromptRole(index: number, role: PresetPrompt['role']) {
  currentPreset.value.prompts[index].role = role
}

function updatePromptContent(index: number, content: string) {
  currentPreset.value.prompts[index].content = content
}

// ── Preset list actions ───────────────────────────────────────────────────────

async function handleOpen(name: string) {
  try {
    await bc.openPreset(name)
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '打开预设失败', 'error')
  }
}

function handlePresetClick(name: string) {
  if (suppressOpen.value || reorderPending.value) return
  void handleOpen(name)
}

function handleNew() {
  currentPreset.value = createEmptyPreset()
}

function handleDuplicate() {
  const src = currentPreset.value
  currentPreset.value = {
    name: src.name ? `${src.name}-copy` : '',
    originalName: '',
    source: 'runtime',
    keywords: [...src.keywords],
    prompts: src.prompts.map(p => ({ role: p.role, content: p.content })),
  }
  toastAdd('已复制为新预设草稿，请修改名称后保存', 'info')
}

async function handleDelete() {
  const name = currentPreset.value.name
  if (!name) return
  try {
    await bc.deletePreset(name)
    toastAdd(`预设「${name}」已删除`, 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '删除失败', 'error')
  }
}

async function handleSave() {
  try {
    await bc.saveCurrentPreset()
    toastAdd(`预设「${currentPreset.value.name}」已保存`, 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '保存失败', 'error')
  }
}

function resetDragState() {
  draggingPresetName.value = null
  dropTargetName.value = null
  dropPosition.value = null
}

function suppressPresetOpen() {
  suppressOpen.value = true
  window.setTimeout(() => {
    suppressOpen.value = false
  }, 160)
}

function buildReorderedPresetNames(
  sourceName: string,
  targetName: string,
  position: 'before' | 'after',
): string[] | null {
  if (sourceName === targetName) return null
  const currentNames = presetItems.value.map(item => item.name)
  const sourceIndex = currentNames.indexOf(sourceName)
  const targetIndex = currentNames.indexOf(targetName)
  if (sourceIndex < 0 || targetIndex < 0) return null

  const nextNames = [...currentNames]
  const [movedName] = nextNames.splice(sourceIndex, 1)
  const anchorIndex = nextNames.indexOf(targetName)
  if (anchorIndex < 0) return null
  const insertIndex = position === 'before' ? anchorIndex : anchorIndex + 1
  nextNames.splice(insertIndex, 0, movedName)

  return nextNames.every((name, index) => name === currentNames[index]) ? null : nextNames
}

function handlePresetDragStart(event: DragEvent, name: string) {
  draggingPresetName.value = name
  dropTargetName.value = name
  dropPosition.value = 'after'
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', name)
  }
}

function handlePresetDragOver(event: DragEvent, name: string) {
  event.preventDefault()
  if (!draggingPresetName.value || draggingPresetName.value === name) return
  const currentTarget = event.currentTarget as HTMLElement | null
  if (!currentTarget) return
  const rect = currentTarget.getBoundingClientRect()
  dropTargetName.value = name
  dropPosition.value = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
}

async function handlePresetDrop(event: DragEvent, targetName: string) {
  event.preventDefault()
  const sourceName = draggingPresetName.value ?? event.dataTransfer?.getData('text/plain')?.trim() ?? ''
  const position = dropPosition.value ?? 'after'
  const nextNames = buildReorderedPresetNames(sourceName, targetName, position)
  suppressPresetOpen()
  if (!nextNames) {
    resetDragState()
    return
  }

  reorderPending.value = true
  try {
    await bc.reorderPresets(nextNames)
    toastAdd('预设顺序已更新', 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '调整顺序失败', 'error')
  } finally {
    reorderPending.value = false
    resetDragState()
  }
}

function handlePresetDragEnd() {
  resetDragState()
}

async function handleSetDefault(name: string) {
  if (!name || settingDefaultPreset.value) return
  if (envDraft.CHATLUNA_DEFAULT_PRESET === name && defaultPreset.value === name) return
  settingDefaultPreset.value = true
  suppressPresetOpen()
  try {
    envDraft.CHATLUNA_DEFAULT_PRESET = name
    await bc.saveEnvPatch(['CHATLUNA_DEFAULT_PRESET'])
    toastAdd(`默认预设已切换为「${name}」`, 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '设为默认预设失败', 'error')
  } finally {
    settingDefaultPreset.value = false
  }
}
</script>

<template>
  <section class="bc-panel">

    <!-- ── Header ──────────────────────────────────────────────────────── -->
    <div class="bc-panel-head">
      <div>
        <h2>角色预设</h2>
        <p>在这里新建、复制、修改和删除角色预设。</p>
      </div>

      <div class="bc-preset-actions">
        <button
          class="bc-btn bc-btn-sm"
          type="button"
          @click="handleNew"
        >
          新建
        </button>
        <button
          class="bc-btn bc-btn-sm"
          type="button"
          :disabled="!currentPreset.name"
          @click="handleDuplicate"
        >
          复制
        </button>
        <InlineConfirm
          label="删除"
          confirm-label="确认删除"
          :disabled="!canDeleteCurrentPreset"
          @confirm="handleDelete"
        />
        <button
          class="bc-btn bc-btn-sm bc-btn-primary"
          type="button"
          :disabled="!canSavePreset"
          @click="handleSave"
        >
          保存预设
        </button>
      </div>
    </div>

    <!-- ── Body grid ────────────────────────────────────────────────────── -->
    <div class="bc-preset-grid">

      <!-- ── Sidebar: preset list ────────────────────────────────────── -->
      <aside class="bc-preset-list">
        <p
          v-if="presetItems.length"
          class="bc-preset-list-tip"
        >
          拖动左侧条目可调整预设顺序。
        </p>

        <p
          v-if="!presetItems.length"
          class="bc-muted"
          style="padding: 0.5rem 0; font-size: 0.85rem;"
        >
          还没有预设文件。
        </p>

        <button
          v-for="item in presetItems"
          :key="item.name"
          class="bc-preset-list-item"
          :class="{
            'is-active': item.name === currentPreset.name,
            'is-dragging': item.name === draggingPresetName,
            'is-drop-before': item.name === dropTargetName && dropPosition === 'before',
            'is-drop-after': item.name === dropTargetName && dropPosition === 'after',
          }"
          type="button"
          :disabled="reorderPending"
          draggable="true"
          @click="handlePresetClick(item.name)"
          @dragstart="(event) => handlePresetDragStart(event, item.name)"
          @dragover="(event) => handlePresetDragOver(event, item.name)"
          @drop="(event) => handlePresetDrop(event, item.name)"
          @dragend="handlePresetDragEnd"
        >
          <span class="bc-preset-list-name">{{ item.name }}</span>
          <span class="bc-badge bc-badge-muted bc-badge-sm">{{ item.source === 'bundled' ? '内置' : '运行时' }}</span>
          <span
            v-if="item.name === defaultPreset"
            class="bc-default-tag"
            title="当前默认预设"
          >默认</span>
          <span
            v-else
            class="bc-preset-set-default"
            role="button"
            tabindex="0"
            :aria-disabled="settingDefaultPreset"
            title="设为默认预设"
            @click.stop="handleSetDefault(item.name)"
            @keydown.enter.stop.prevent="handleSetDefault(item.name)"
            @keydown.space.stop.prevent="handleSetDefault(item.name)"
          >设为默认</span>
        </button>
      </aside>

      <!-- ── Editor ─────────────────────────────────────────────────── -->
      <div class="bc-preset-editor">

        <!-- Meta fields -->
        <div class="bc-field-grid">

          <!-- Name -->
          <label class="bc-field">
            <span class="bc-field-label">预设名</span>
            <input
              type="text"
              :value="currentPreset.name"
              spellcheck="false"
              placeholder="只允许字母、数字、点号、下划线、短横线"
              @input="(e) => { currentPreset.name = (e.target as HTMLInputElement).value }"
            >
            <em class="bc-field-note">来源：{{ currentPresetSourceLabel }}。保存后都会写入运行时预设层。</em>
          </label>

          <!-- Keywords -->
          <label class="bc-field bc-field-span">
            <span class="bc-field-label">触发关键词</span>
            <textarea
              :value="keywordsText"
              rows="3"
              spellcheck="false"
              placeholder="一行一个关键词，用于 /chatluna 预设切换匹配"
              @input="(e) => { keywordsText = (e.target as HTMLTextAreaElement).value }"
            />
            <em class="bc-field-note">一行一个关键词。留空则不参与关键词匹配。</em>
          </label>
        </div>

        <!-- Prompt list -->
        <div class="bc-panel-subhead">
          <strong style="font-size: 0.9rem; color: var(--k-text-dark);">
            提示词片段
            <span class="bc-badge bc-badge-muted" style="margin-left: 0.4rem; vertical-align: middle;">
              {{ currentPreset.prompts.length }}
            </span>
          </strong>
          <button
            class="bc-btn bc-btn-sm"
            type="button"
            @click="addPrompt"
          >
            + 新增片段
          </button>
        </div>

        <div class="bc-prompt-list">
          <div
            v-for="(prompt, index) in currentPreset.prompts"
            :key="index"
            class="bc-prompt-card"
          >
            <!-- Prompt header: role selector + delete -->
            <div class="bc-prompt-head">
              <label class="bc-prompt-role">
                <span>角色</span>
                <select
                  :value="prompt.role"
                  @change="(e) => updatePromptRole(index, (e.target as HTMLSelectElement).value as PresetPrompt['role'])"
                >
                  <option
                    v-for="(label, role) in ROLE_LABELS"
                    :key="role"
                    :value="role"
                  >{{ label }}</option>
                </select>
              </label>

              <span class="bc-badge bc-badge-muted bc-badge-sm" style="flex: 1; max-width: 3rem; text-align: center;">
                #{{ index + 1 }}
              </span>

              <button
                class="bc-btn bc-btn-sm bc-btn-ghost"
                type="button"
                :disabled="currentPreset.prompts.length <= 1"
                :title="currentPreset.prompts.length <= 1 ? '至少保留一段提示词' : '删除此片段'"
                @click="removePrompt(index)"
              >
                删除
              </button>
            </div>

            <!-- Content textarea -->
            <textarea
              :value="prompt.content"
              rows="5"
              spellcheck="false"
              :placeholder="`${ROLE_LABELS[prompt.role] ?? prompt.role} 提示词内容…`"
              @input="(e) => updatePromptContent(index, (e.target as HTMLTextAreaElement).value)"
            />
          </div>
        </div>

        <!-- Empty preset hint -->
        <p
          v-if="!currentPreset.name && !botState?.presets?.length"
          class="bc-muted"
          style="font-size: 0.85rem; padding: 0.5rem 0;"
        >
          点击"新建"创建一个预设，或从左侧列表中选择已有预设进行编辑。
        </p>

      </div>
    </div>

  </section>
</template>
