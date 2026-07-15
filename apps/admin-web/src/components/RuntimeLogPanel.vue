<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AdminLogEntry, AdminLogsResponse } from '@contracts';
import { api } from '@/api/client';

const MAX_VISIBLE_ENTRIES = 400;
const POLL_INTERVAL_MS = 1_500;

const entries = ref<AdminLogEntry[]>([]);
const cursor = ref(0);
const loading = ref(false);
const paused = ref(false);
const autoFollow = ref(true);
const level = ref<'all' | AdminLogEntry['level']>('all');
const query = ref('');
const errorMessage = ref('');
const viewport = ref<HTMLElement | null>(null);
let timer: number | undefined;

const filteredEntries = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return entries.value.filter((entry) => {
    if (level.value !== 'all' && entry.level !== level.value) return false;
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
    const response = await api<AdminLogsResponse>(`/logs?after=${cursor.value}&limit=100`);
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
          <el-option label="全部级别" value="all" />
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
.log-panel { min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.log-panel-head { min-height: 50px; align-items: center; padding: 9px 14px; }
.log-title-line { display: flex; align-items: center; gap: 10px; }
.live-state { display: inline-flex; align-items: center; gap: 5px; color: #29785f; font-size: 10px; font-weight: 650; }
.live-state i { width: 6px; height: 6px; border-radius: 50%; background: #22a77b; box-shadow: 0 0 0 3px rgba(34,167,123,.12); }
.live-state.paused { color: #8a6470; }
.live-state.paused i { background: #a7818b; box-shadow: none; }
.log-toolbar { display: flex; align-items: center; gap: 8px; }
.log-search { width: 240px; }
.log-level { width: 126px; }
.log-error { padding: 8px 18px; color: #a23649; background: #fff2f4; border-bottom: 1px solid #f2d8de; font-size: 11px; }
.log-viewport { height: 300px; min-height: 260px; flex: none; overflow: auto; background: #fbfcfe; scrollbar-color: #ccd4df transparent; }
.log-list { min-width: 760px; padding: 8px 0; }
.log-row { display: grid; grid-template-columns: 92px 62px 150px minmax(320px, 1fr); align-items: start; min-height: 25px; padding: 4px 14px; border-left: 2px solid transparent; color: #4b5565; font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; line-height: 1.5; }
.log-row:hover { background: #f2f5f9; border-left-color: #aabbe8; }
.log-row time { color: #929cab; font-variant-numeric: tabular-nums; }
.log-level-chip { width: fit-content; min-width: 48px; padding: 1px 6px; border-radius: 4px; color: #526072; background: #edf0f4; text-align: center; text-transform: uppercase; font-size: 9px; font-weight: 750; }
.log-level-chip.error { color: #b13d50; background: #feecef; }
.log-level-chip.warn { color: #9b661d; background: #fff3dd; }
.log-level-chip.success { color: #24755d; background: #e7f7f1; }
.log-level-chip.debug { color: #6b5ba6; background: #f0ecfb; }
.log-namespace { overflow: hidden; padding-right: 16px; color: #375786; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.log-row pre { margin: 0; overflow-wrap: anywhere; color: #3e4755; font: inherit; white-space: pre-wrap; }
.log-empty { height: 100%; display: grid; place-items: center; color: #9aa3b1; font-size: 11px; }
.log-footer { min-height: 34px; display: flex; align-items: center; justify-content: space-between; padding: 4px 14px; border-top: 1px solid var(--line); color: #8a93a2; background: #fff; font-size: 10px; }
.log-footer label { display: flex; align-items: center; gap: 6px; }

@media (max-width: 960px) {
  .log-panel-head { align-items: flex-start; flex-direction: column; }
  .log-toolbar { width: 100%; flex-wrap: wrap; }
  .log-search { flex: 1; min-width: 220px; }
}

@media (max-width: 600px) {
  .log-search { width: 100%; flex-basis: 100%; }
  .log-level { flex: 1; }
  .log-viewport { height: 340px; }
  .log-row { grid-template-columns: 78px 56px minmax(112px, .5fr) minmax(280px, 1fr); padding-inline: 10px; }
  .log-footer span { display: none; }
}
</style>
