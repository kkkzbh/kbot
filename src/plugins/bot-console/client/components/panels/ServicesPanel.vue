<script setup lang="ts">
import { inject, computed } from 'vue'
import { useToast } from '../../composables/useToast'
import {
  VISIBLE_SERVICE_UNITS,
  getServiceLabel,
  getServiceHint,
  getActiveStateLabel,
  getSubStateLabel,
  getUnitFileStateLabel,
  getActiveStateTone,
  getStatusDotClass,
  getAutoStartButtonLabel,
} from '../../utils/constants'
import type { useBotConsole } from '../../composables/useBotConsole'
import type { BotServiceStatus } from '../../types'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

// servicePending is a reactive plain object — no .value needed
const { servicePending } = bc

// ── Derived state ─────────────────────────────────────────────────────────────

const services = computed<BotServiceStatus[]>(() => bc.botState.value?.services ?? [])

const visibleServices = computed(() =>
  VISIBLE_SERVICE_UNITS
    .map(unit => services.value.find(s => s.unit === unit))
    .filter((s): s is BotServiceStatus => s != null),
)

function getSubService(unit: string): BotServiceStatus | undefined {
  return services.value.find(s => s.unit === unit)
}

function isPending(unit: string): boolean {
  return !!servicePending[unit]
}

function pendingActionLabel(unit: string): string {
  const action = servicePending[unit]
  if (!action) return ''
  const labels: Record<string, string> = {
    start: '启动中…',
    stop: '停止中…',
    restart: '重启中…',
    enable: '启用中…',
  }
  return labels[action] ?? '操作中…'
}

function restartButtonLabel(unit: string): string {
  if (servicePending[unit] === 'restart') {
    return unit === 'qqbot.target' ? '全栈重启中…' : '重启中…'
  }
  return unit === 'qqbot.target' ? '全栈重启' : '重启'
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function handleAction(unit: string, action: string) {
  try {
    await bc.runServiceAction(unit, action)
    const doneLabels: Record<string, string> = {
      start: '已启动',
      stop: '已停止',
      restart: '已重启',
      enable: '已启用开机自启',
    }
    if (unit === 'qqbot.target' && action === 'restart') {
      toastAdd(`${getServiceLabel(unit)} 已触发全栈重启`, 'success')
      return
    }
    toastAdd(`${getServiceLabel(unit)} ${doneLabels[action] ?? action}`, 'success')
  } catch (e: unknown) {
    toastAdd(e instanceof Error ? e.message : '操作失败', 'error')
  }
}
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>运行控制</h2>
        <p class="bc-muted">
          这里保留全栈启停与依赖服务视图。日常改配置后的“重启机器人”只会重启主机器人进程，不会连带重启依赖栈。
        </p>
      </div>
    </div>

    <div class="bc-services">
      <template v-if="visibleServices.length">
        <div
          v-for="service in visibleServices"
          :key="service.unit"
          :class="['bc-service-card', `is-${getActiveStateTone(service.activeState)}`]"
        >
          <!-- ── Info column ───────────────────────────────────────────── -->
          <div class="bc-service-main">
            <div class="bc-service-title-row">
              <p class="bc-service-title">
              <span :class="['bc-status-dot', getStatusDotClass(service.activeState)]" />
              <strong>{{ getServiceLabel(service.unit, service.description) }}</strong>
              </p>
              <span class="bc-service-unit">{{ service.unit }}</span>
            </div>

            <p class="bc-service-summary">{{ getServiceHint(service.unit) }}</p>

            <!-- Inline core service status only for qqbot.target -->
            <template v-if="service.unit === 'qqbot.target'">
              <p
                v-if="getSubService('qqbot-pmhq.service') || getSubService('qqbot-llbot.service') || getSubService('qqbot-koishi.service') || getSubService('cloudflared-qqbot-hbu-jw.service') || getSubService('cloudflared-qqbot-genshin.service')"
                class="bc-service-stack"
              >
                已包含：
                <template v-if="getSubService('qqbot-pmhq.service')">
                  PMHQ&nbsp;
                  <span
                    :class="[
                      'bc-status-badge',
                      `is-${getActiveStateTone(getSubService('qqbot-pmhq.service')!.activeState)}`,
                    ]"
                  >
                    {{ getActiveStateLabel(getSubService('qqbot-pmhq.service')!.activeState) }}
                  </span>
                </template>
                <template v-if="getSubService('qqbot-llbot.service')">
                  &nbsp;/ LLBot&nbsp;
                  <span
                    :class="[
                      'bc-status-badge',
                      `is-${getActiveStateTone(getSubService('qqbot-llbot.service')!.activeState)}`,
                    ]"
                  >
                    {{ getActiveStateLabel(getSubService('qqbot-llbot.service')!.activeState) }}
                  </span>
                </template>
                <template v-if="getSubService('qqbot-koishi.service')">
                  &nbsp;/ 主机器人&nbsp;
                  <span
                    :class="[
                      'bc-status-badge',
                      `is-${getActiveStateTone(getSubService('qqbot-koishi.service')!.activeState)}`,
                    ]"
                  >
                    {{ getActiveStateLabel(getSubService('qqbot-koishi.service')!.activeState) }}
                  </span>
                </template>
                <template v-if="getSubService('cloudflared-qqbot-hbu-jw.service')">
                  &nbsp;/ 教务隧道&nbsp;
                  <span
                    :class="[
                      'bc-status-badge',
                      `is-${getActiveStateTone(getSubService('cloudflared-qqbot-hbu-jw.service')!.activeState)}`,
                    ]"
                  >
                    {{ getActiveStateLabel(getSubService('cloudflared-qqbot-hbu-jw.service')!.activeState) }}
                  </span>
                </template>
                <template v-if="getSubService('cloudflared-qqbot-genshin.service')">
                  &nbsp;/ 原神隧道&nbsp;
                  <span
                    :class="[
                      'bc-status-badge',
                      `is-${getActiveStateTone(getSubService('cloudflared-qqbot-genshin.service')!.activeState)}`,
                    ]"
                  >
                    {{ getActiveStateLabel(getSubService('cloudflared-qqbot-genshin.service')!.activeState) }}
                  </span>
                </template>
              </p>
            </template>

            <div class="bc-service-meta-grid">
              <div class="bc-service-meta-row">
                <span>当前状态</span>
                <span :class="['bc-status-badge', `is-${getActiveStateTone(service.activeState)}`]">
                  {{
                    isPending(service.unit)
                      ? pendingActionLabel(service.unit)
                      : getActiveStateLabel(service.activeState)
                  }}
                </span>
              </div>
              <div class="bc-service-meta-row">
                <span>运行情况</span>
                <strong>{{ getSubStateLabel(service.subState) }}</strong>
              </div>
              <div class="bc-service-meta-row">
                <span>开机自启</span>
                <strong>{{ getUnitFileStateLabel(service.unitFileState) }}</strong>
              </div>
            </div>
          </div>

          <!-- ── Action buttons ───────────────────────────────────────── -->
          <div class="bc-service-actions-panel">
            <div class="bc-service-actions">
            <button
              type="button"
              class="bc-btn"
              :disabled="!service.canStart || isPending(service.unit)"
              @click="handleAction(service.unit, 'start')"
            >
              启动
            </button>
            <button
              type="button"
              class="bc-btn bc-btn-danger"
              :disabled="!service.canStop || isPending(service.unit)"
              @click="handleAction(service.unit, 'stop')"
            >
              停止
            </button>
            <button
              type="button"
              class="bc-btn bc-btn-primary"
              :disabled="!service.canRestart || isPending(service.unit)"
              @click="handleAction(service.unit, 'restart')"
            >
              {{ restartButtonLabel(service.unit) }}
            </button>
            <button
              type="button"
              class="bc-btn"
              :disabled="!service.canEnable || isPending(service.unit)"
              @click="handleAction(service.unit, 'enable')"
            >
              {{ getAutoStartButtonLabel(service.canEnable) }}
            </button>
            </div>
          </div>
        </div>
      </template>

      <!-- Empty / loading state -->
      <div v-else class="bc-empty-state">
        <p class="bc-muted">暂无服务状态，请稍候或点击刷新。</p>
      </div>
    </div>
  </section>
</template>
