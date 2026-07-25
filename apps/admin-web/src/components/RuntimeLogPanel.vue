<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AdminLogEntry, AdminLogsResponse } from '@contracts';
import { rawApi } from '@/api/client';

const MAX_VISIBLE_ENTRIES = 1_000;
const POLL_INTERVAL_MS = 1_500;

const entries = ref<AdminLogEntry[]>([]);
const cursor = ref(0);
const loading = ref(false);
const paused = ref(false);
const autoFollow = ref(true);
type LogLevelFilter = 'standard' | 'all' | AdminLogEntry['level'];
const level = ref<LogLevelFilter>('standard');
const query = ref('');
const errorMessage = ref('');
const viewport = ref<HTMLElement | null>(null);
let timer: number | undefined;

const filteredEntries = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return entries.value.filter((entry) => {
    if (level.value === 'standard' && entry.level === 'debug') return false;
    if (level.value !== 'standard' && level.value !== 'all' && entry.level !== level.value) return false;
    if (!needle) return true;
    return `${entry.namespace} ${entry.content}`.toLowerCase().includes(needle);
  });
});

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(timestamp);
}

async function scrollToLatest(): Promise<void> {
  if (!autoFollow.value) return;
  await nextTick();
  if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight;
}

async function loadLogs(): Promise<void> {
  if (paused.value || loading.value) return;
  loading.value = true;
  try {
    const response = await rawApi<AdminLogsResponse>(`/logs?after=${cursor.value}&limit=100`);
    if (response.truncated) entries.value = [];
    if (response.entries.length) {
      const seen = new Set(entries.value.map((entry) => entry.id));
      entries.value.push(...response.entries.filter((entry) => !seen.has(entry.id)));
      if (entries.value.length > MAX_VISIBLE_ENTRIES) {
        entries.value.splice(0, entries.value.length - MAX_VISIBLE_ENTRIES);
      }
      await scrollToLatest();
    }
    cursor.value = response.nextCursor;
    errorMessage.value = '';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '日志读取失败';
  } finally {
    loading.value = false;
  }
}

function togglePaused(): void {
  paused.value = !paused.value;
  if (!paused.value) void loadLogs();
}

function clearView(): void {
  entries.value = [];
}

onMounted(() => {
  void loadLogs();
  timer = window.setInterval(() => void loadLogs(), POLL_INTERVAL_MS);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <article class="panel log-panel">
    <div class="panel-head log-panel-head">
      <div>
        <div class="log-title-line">
          <h2>运行日志</h2>
          <span class="live-state" :class="{ paused }"><i />{{ paused ? '已暂停' : '实时跟随' }}</span>
        </div>
        <p>Koishi 进程日志 · 最近 {{ entries.length }} 条</p>
      </div>
      <div class="log-toolbar">
        <el-input v-model="query" clearable placeholder="搜索 namespace 或内容" class="log-search" />
        <el-select v-model="level" class="log-level" aria-label="日志级别">
          <el-option label="常规日志" value="standard" />
          <el-option label="全部日志" value="all" />
          <el-option label="Error" value="error" />
          <el-option label="Warn" value="warn" />
          <el-option label="Info" value="info" />
          <el-option label="Success" value="success" />
          <el-option label="Debug" value="debug" />
        </el-select>
        <el-button @click="togglePaused">{{ paused ? '继续' : '暂停' }}</el-button>
        <el-button @click="clearView">清空视图</el-button>
      </div>
    </div>
    <div v-if="errorMessage" class="log-error">{{ errorMessage }}</div>
    <div ref="viewport" class="log-viewport">
      <div v-if="filteredEntries.length" class="log-list">
        <div v-for="entry in filteredEntries" :key="entry.id" class="log-row">
          <time>{{ formatTime(entry.timestamp) }}</time>
          <span class="log-level-chip" :class="entry.level">{{ entry.level }}</span>
          <span class="log-namespace">{{ entry.namespace }}</span>
          <pre>{{ entry.content }}</pre>
        </div>
      </div>
      <div v-else class="log-empty">{{ entries.length ? '没有符合筛选条件的日志' : '等待新的运行日志…' }}</div>
    </div>
    <footer class="log-footer">
      <label><el-checkbox v-model="autoFollow" />自动滚动到最新日志</label>
      <span>缓存上限 {{ MAX_VISIBLE_ENTRIES }} 条</span>
    </footer>
  </article>
</template>

<style scoped>
.log-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.log-panel-head { min-height: 68px; align-items: center; padding: 12px 16px; }
.log-title-line { display: flex; align-items: center; gap: 10px; }
.log-title-line h2 { font-size: 16px; }
.live-state { display: inline-flex; align-items: center; gap: 6px; color: #29785f; font-size: 12px; font-weight: 650; }
.live-state i { width: 7px; height: 7px; border-radius: 50%; background: #22a77b; box-shadow: 0 0 0 3px rgba(34,167,123,.12); }
.live-state.paused { color: #8a6470; }
.live-state.paused i { background: #a7818b; box-shadow: none; }
.log-toolbar { display: flex; align-items: center; gap: 10px; }
.log-search { width: 320px; }
.log-level { width: 138px; }
.log-error { padding: 10px 18px; color: #a23649; background: #fff2f4; border-bottom: 1px solid #f2d8de; font-size: 12px; }
.log-viewport { min-height: 0; flex: 1; overflow: auto; background: #fff; scrollbar-color: #c5ceda transparent; }
.log-list { min-width: 980px; padding: 6px 0; }
.log-row {
  display: grid;
  grid-template-columns: 116px 78px 210px minmax(480px, 1fr);
  align-items: start;
  min-height: 34px;
  padding: 6px 16px;
  border-bottom: 1px solid #f0f2f5;
  color: #374151;
  font-family: "JetBrains Mono", "Cascadia Code", "Noto Sans Mono", "Liberation Mono", monospace;
  font-size: 13px;
  font-variant-ligatures: none;
  line-height: 1.65;
}
.log-row:nth-child(even) { background: #fbfcfd; }
.log-row:hover { background: #f1f5fb; }
.log-row time { padding-top: 1px; color: #7b8798; font-variant-numeric: tabular-nums; }
.log-level-chip { width: fit-content; min-width: 64px; padding: 2px 8px; border-radius: 6px; color: #526072; background: #edf0f4; text-align: center; text-transform: uppercase; font-size: 11px; font-weight: 750; line-height: 18px; }
.log-level-chip.error { color: #b13d50; background: #feecef; }
.log-level-chip.warn { color: #9b661d; background: #fff3dd; }
.log-level-chip.success { color: #24755d; background: #e7f7f1; }
.log-level-chip.debug { color: #6b5ba6; background: #f0ecfb; }
.log-namespace { overflow: hidden; padding: 1px 20px 0 0; color: #2f568a; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.log-row pre { margin: 0; overflow-wrap: anywhere; color: #283548; font: inherit; white-space: pre-wrap; }
.log-empty { height: 100%; display: grid; place-items: center; color: #8b95a5; font-size: 13px; }
.log-footer { min-height: 42px; display: flex; align-items: center; justify-content: space-between; padding: 6px 16px; border-top: 1px solid var(--line); color: #737f90; background: #fff; font-size: 12px; }
.log-footer label { display: flex; align-items: center; gap: 6px; }

@media (max-width: 960px) {
  .log-panel-head { align-items: flex-start; flex-direction: column; }
  .log-toolbar { width: 100%; flex-wrap: wrap; }
  .log-search { flex: 1; min-width: 220px; }
}

@media (max-width: 600px) {
  .log-search { width: 100%; flex-basis: 100%; }
  .log-level { flex: 1; }
  .log-list { min-width: 900px; }
  .log-row { grid-template-columns: 108px 72px 180px minmax(420px, 1fr); padding-inline: 12px; }
  .log-footer span { display: none; }
}
</style>
