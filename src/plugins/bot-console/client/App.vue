<script setup lang="ts">
import { ref, provide, onMounted, type Component } from 'vue'
import { useBotConsole } from './composables/useBotConsole'
import { useToast } from './composables/useToast'
import { useKeyboard } from './composables/useKeyboard'
import ToastContainer from './components/ToastContainer.vue'
import OverviewPanel from './components/panels/OverviewPanel.vue'
import AnalyticsPanel from './components/panels/AnalyticsPanel.vue'
import ServicesPanel from './components/panels/ServicesPanel.vue'
import FeaturesPanel from './components/panels/FeaturesPanel.vue'
import ToolPolicyPanel from './components/panels/ToolPolicyPanel.vue'
import HbuJwPanel from './components/panels/HbuJwPanel.vue'
import ZyhPanel from './components/panels/ZyhPanel.vue'
import HbuSecondClassPanel from './components/panels/HbuSecondClassPanel.vue'
import GenshinPanel from './components/panels/GenshinPanel.vue'
import MemoryPanel from './components/panels/MemoryPanel.vue'
import AffinityPanel from './components/panels/AffinityPanel.vue'
import ModelsPanel from './components/panels/ModelsPanel.vue'
import TtsPanel from './components/panels/TtsPanel.vue'
import BasicPanel from './components/panels/BasicPanel.vue'
import PresetsPanel from './components/panels/PresetsPanel.vue'

const props = withDefaults(defineProps<{
  embedded?: boolean
}>(), {
  embedded: false,
})

// ── Composables ───────────────────────────────────────────────────────────────

const bc    = useBotConsole()
const toast = useToast()

provide('bc', bc)
provide('toast', toast)

// ── Tab state ─────────────────────────────────────────────────────────────────

const activeTab = ref('overview')

const TABS = [
  { id: 'overview', label: '服务总览' },
  { id: 'analytics', label: '数据统计' },
  { id: 'services', label: '运行控制' },
  { id: 'features', label: '功能开关' },
  { id: 'hbu-jw', label: '教务系统' },
  { id: 'zyh', label: '志愿汇' },
  { id: 'hbu-second-class', label: '二课' },
  { id: 'genshin', label: '原神' },
  { id: 'tools', label: '工具控制' },
  { id: 'affinity', label: '关系事件' },
  { id: 'memory', label: '长期记忆' },
  { id: 'models',   label: '模型接口' },
  { id: 'tts',      label: 'TTS 语音' },
  { id: 'basic',    label: '基础配置' },
  { id: 'presets',  label: '角色预设' },
] as const

const panelMap: Record<string, Component> = {
  overview: OverviewPanel,
  analytics: AnalyticsPanel,
  services: ServicesPanel,
  features: FeaturesPanel,
  'hbu-jw': HbuJwPanel,
  zyh: ZyhPanel,
  'hbu-second-class': HbuSecondClassPanel,
  genshin: GenshinPanel,
  tools: ToolPolicyPanel,
  affinity: AffinityPanel,
  memory: MemoryPanel,
  models:   ModelsPanel,
  tts:      TtsPanel,
  basic:    BasicPanel,
  presets:  PresetsPanel,
}

// ── Keyboard shortcuts (Ctrl+S to save) ───────────────────────────────────────

useKeyboard(bc, toast, activeTab)

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    await bc.refresh()
  } catch (err: unknown) {
    toast.add(err instanceof Error ? err.message : '加载状态失败', 'error')
  }
})

// ── Hero actions ──────────────────────────────────────────────────────────────

async function handleRefresh() {
  try {
    await bc.refresh()
    toast.add('状态已刷新', 'success')
  } catch (err: unknown) {
    toast.add(err instanceof Error ? err.message : '刷新失败', 'error')
  }
}

async function handleRestart() {
  try {
    if (bc.pendingSettingsCount.value > 0) {
      await bc.saveAllSettingsAndRestart()
      toast.add('全部配置已保存，机器人主程序已触发重启', 'success')
      return
    }
    await bc.restartBot()
    toast.add('机器人主程序已触发重启', 'success')
  } catch (err: unknown) {
    toast.add(err instanceof Error ? err.message : '保存并重启失败', 'error')
  }
}

// Destructure refs so they auto-unwrap in the template
const { loading, botState } = bc
</script>

<template>
  <div
    class="bot-console-page"
    :class="{ 'is-embedded': props.embedded }"
  >
    <div class="bc-shell">

      <!-- ── Hero ──────────────────────────────────────────────────────── -->
      <section class="bc-hero">
        <div class="bc-hero-copy">
          <p class="bc-eyebrow">本地控制台</p>
          <h1>机器人管理台</h1>
          <p class="bc-muted">
            直接开关功能、调整配置、管理角色预设。保存后通常需要重启才会生效。
          </p>
        </div>

        <div class="bc-hero-actions">
          <button
            class="bc-btn"
            type="button"
            :disabled="loading"
            @click="handleRefresh"
          >
            {{ loading ? '加载中…' : '刷新状态' }}
          </button>
          <button
            class="bc-btn bc-btn-primary"
            type="button"
            :disabled="!!bc.servicePending['qqbot-koishi.service'] || bc.savingAllSettings.value"
            @click="handleRestart"
          >
            {{
              bc.savingAllSettings.value || bc.servicePending['qqbot-koishi.service']
                ? '保存并重启中…'
                : bc.pendingSettingsCount.value > 0
                  ? `保存全部并重启 (${bc.pendingSettingsCount.value})`
                  : '重启机器人'
            }}
          </button>
        </div>
      </section>

      <!-- ── Sticky tab bar ─────────────────────────────────────────────── -->
      <nav
        class="bc-tabbar-wrap"
        aria-label="机器人控制台分区"
      >
        <div class="bc-tabbar" role="tablist">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            class="bc-tab"
            :class="{ 'is-active': activeTab === tab.id }"
            role="tab"
            :aria-selected="activeTab === tab.id"
            type="button"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>
      </nav>

      <transition name="bc-savebar">
        <section
          v-if="bc.pendingSettingsCount.value > 0"
          class="bc-global-savebar"
          aria-live="polite"
        >
          <div>
            <strong>共有 {{ bc.pendingSettingsCount.value }} 项修改待保存</strong>
            <p>修改可能分布在多个页面；全部保存后统一重启一次。</p>
          </div>
          <button
            class="bc-btn bc-btn-primary"
            type="button"
            :disabled="!bc.canSaveAllSettings.value"
            @click="handleRestart"
          >
            {{ bc.savingAllSettings.value ? '保存并重启中…' : '保存全部并重启' }}
          </button>
        </section>
      </transition>

      <!-- ── Initial loading skeleton (only before first successful fetch) -->
      <div
        v-if="loading && !botState"
        class="bc-loading"
        aria-live="polite"
        aria-label="正在加载"
      >
        <div class="bc-loading-inner">
          <span class="bc-loading-dot" />
          <span>正在加载机器人状态…</span>
        </div>
      </div>

      <!-- ── Active panel ───────────────────────────────────────────────── -->
      <div v-else>
        <component
          :is="panelMap[activeTab] ?? panelMap['overview']"
          :key="activeTab"
        />
      </div>

    </div>

    <!-- ── Toast notifications (fixed position, bottom-right) ────────── -->
    <ToastContainer />
  </div>
</template>
