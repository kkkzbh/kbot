<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  groupSummaryAdminStateSchema,
  groupSummaryClearRequestSchema,
  groupSummaryClearResponseSchema,
  groupSummaryDetailSchema,
  groupSummaryGroupRequestSchema,
  groupSummaryGroupSchema,
  groupSummaryMessagesResponseSchema,
  groupSummaryPreviewSchema,
  groupSummaryRangeRequestSchema,
  groupSummarySettingsRequestSchema,
  groupSummaryTaskSchema,
  groupSummaryTaskRequestSchema,
  type GroupSummaryAdminState,
  type GroupSummaryDetail,
  type GroupSummaryDocumentContract,
} from '@contracts';
import { api, jsonBody } from '@/api/client';

type GroupRow = GroupSummaryAdminState['groups'][number];

const state = ref<GroupSummaryAdminState | null>(null);
const selectedGroupId = ref('');
const detail = ref<GroupSummaryDetail | null>(null);
const messages = ref<Array<{ id: number; senderName: string; capturedAt: number; text: string; media: unknown[] }>>([]);
const loading = ref(false);
const operation = ref('');
const loadError = ref('');
const defaultPromptDraft = ref('');
const promptOverrideDraft = ref('');
const manualStart = ref('');
const manualEnd = ref('');
const preview = ref<null | { messageCount: number; startAt: number | null; endAt: number | null; mediaCount: number; firstMessageId: number | null; lastMessageId: number | null }>(null);
let pollTimer: number | undefined;

const selectedRow = computed(() => state.value?.groups.find((row) => row.groupId === selectedGroupId.value) ?? null);
const activeTask = computed(() => detail.value?.latestTask && ['pending', 'running'].includes(detail.value.latestTask.status)
  ? detail.value.latestTask
  : null);

async function loadState(): Promise<void> {
  state.value = await api('/group-summaries', groupSummaryAdminStateSchema);
  defaultPromptDraft.value = state.value.defaultPrompt;
  if (!selectedGroupId.value && state.value.groups.length) selectedGroupId.value = state.value.groups[0]!.groupId;
}

async function loadDetail(): Promise<void> {
  if (!selectedGroupId.value) { detail.value = null; messages.value = []; return; }
  const groupId = selectedGroupId.value;
  const [nextDetail, messagePage] = await Promise.all([
    api(`/group-summaries/groups/${groupId}`, groupSummaryDetailSchema),
    api(`/group-summaries/groups/${groupId}/messages?page=1&pageSize=30`, groupSummaryMessagesResponseSchema),
  ]);
  if (selectedGroupId.value !== groupId) return;
  detail.value = nextDetail;
  messages.value = messagePage.items;
  promptOverrideDraft.value = nextDetail.group.promptOverride ?? '';
  schedulePoll();
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    await loadState();
    await loadDetail();
    loadError.value = '';
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '群聊总结数据加载失败';
  } finally {
    loading.value = false;
  }
}

async function selectGroup(groupId: string): Promise<void> {
  selectedGroupId.value = groupId;
  preview.value = null;
  await loadDetail();
}

async function saveDefaultPrompt(): Promise<void> {
  operation.value = 'default-prompt';
  try {
    const input = { defaultPrompt: defaultPromptDraft.value };
    await api('/group-summaries/settings', groupSummarySettingsRequestSchema, {
      method: 'PATCH', body: jsonBody(groupSummarySettingsRequestSchema, input),
    });
    ElMessage.success('全局总结提示词已保存');
    await loadState();
  } finally { operation.value = ''; }
}

async function saveGroup(patch: { enabled?: boolean; promptOverride?: string | null; roomName?: string | null }): Promise<void> {
  if (!selectedRow.value && !detail.value) return;
  const group = detail.value?.group ?? selectedRow.value!;
  const input = {
    enabled: patch.enabled ?? group.enabled,
    roomName: patch.roomName === undefined ? group.roomName : patch.roomName,
    promptOverride: patch.promptOverride === undefined ? group.promptOverride : patch.promptOverride,
  };
  operation.value = 'group-settings';
  try {
    await api(`/group-summaries/groups/${group.groupId}`, groupSummaryGroupSchema, {
      method: 'PUT', body: jsonBody(groupSummaryGroupRequestSchema, input),
    });
    await refresh();
  } finally { operation.value = ''; }
}

async function toggleGroup(row: GroupRow, enabled: boolean): Promise<void> {
  selectedGroupId.value = row.groupId;
  await saveGroup({ enabled, roomName: row.roomName, promptOverride: row.promptOverride });
  ElMessage.success(enabled ? '已开始记录该群的新消息' : '已停止记录，历史数据继续保留');
}

async function addGroup(): Promise<void> {
  let value: { value: string };
  try {
    value = await ElMessageBox.prompt('输入 QQ 群号', '添加群聊范围', {
      inputPattern: /^\d+$/u, inputErrorMessage: '请输入有效 QQ 群号', confirmButtonText: '添加',
    }) as { value: string };
  } catch { return; }
  await api(`/group-summaries/groups/${value.value}`, groupSummaryGroupSchema, {
    method: 'PUT',
    body: jsonBody(groupSummaryGroupRequestSchema, { enabled: true, roomName: value.value, promptOverride: null }),
  });
  selectedGroupId.value = value.value;
  await refresh();
}

async function savePromptOverride(): Promise<void> {
  await saveGroup({ promptOverride: promptOverrideDraft.value.trim() || null });
  ElMessage.success(promptOverrideDraft.value.trim() ? '群级提示词已保存' : '已恢复使用全局提示词');
}

function rangeInput(mode: 'automatic' | 'manual') {
  if (mode === 'automatic') return { mode } as const;
  const startAt = new Date(manualStart.value).getTime();
  const endAt = new Date(manualEnd.value).getTime();
  return { mode, startAt, endAt } as const;
}

async function previewRange(): Promise<void> {
  if (!selectedGroupId.value) return;
  const input = groupSummaryRangeRequestSchema.parse(rangeInput('manual'));
  preview.value = await api(`/group-summaries/groups/${selectedGroupId.value}/preview`, groupSummaryPreviewSchema, {
    method: 'POST', body: jsonBody(groupSummaryRangeRequestSchema, input),
  });
}

async function createSummary(mode: 'automatic' | 'manual'): Promise<void> {
  if (!selectedGroupId.value) return;
  const input = mode === 'automatic'
    ? groupSummaryTaskRequestSchema.parse({ mode })
    : groupSummaryTaskRequestSchema.parse({
      ...rangeInput(mode),
      firstMessageId: preview.value?.firstMessageId,
      lastMessageId: preview.value?.lastMessageId,
    });
  operation.value = 'create-task';
  try {
    const task = await api(`/group-summaries/groups/${selectedGroupId.value}/tasks`, groupSummaryTaskSchema, {
      method: 'POST', body: jsonBody(groupSummaryTaskRequestSchema, input),
    });
    ElMessage.success(`已创建总结任务，共 ${task.messageCount} 条消息`);
    await loadDetail();
  } finally { operation.value = ''; }
}

async function clearData(): Promise<void> {
  const groupId = selectedGroupId.value;
  if (!groupId) return;
  let confirmation: { value: string };
  try {
    confirmation = await ElMessageBox.prompt(`永久删除群 ${groupId} 的原始消息、任务、批次和当前总览。请输入群号确认。`, '清除群聊总结数据', {
      type: 'warning', confirmButtonText: '永久清除', inputPattern: new RegExp(`^${groupId}$`, 'u'), inputErrorMessage: '群号不一致',
    }) as { value: string };
  } catch { return; }
  await api(`/group-summaries/groups/${groupId}/data`, groupSummaryClearResponseSchema, {
    method: 'DELETE', body: jsonBody(groupSummaryClearRequestSchema, { confirmGroupId: confirmation.value }),
  });
  ElMessage.success('该群的总结数据已清除');
  await refresh();
}

function schedulePoll(): void {
  if (pollTimer) window.clearTimeout(pollTimer);
  if (!activeTask.value) return;
  pollTimer = window.setTimeout(async () => {
    try { await loadDetail(); await loadState(); } finally { schedulePoll(); }
  }, 1800);
}

function formatTime(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function evidenceCount(document: GroupSummaryDocumentContract): number {
  return new Set([
    ...document.institutions.flatMap((item) => item.evidenceMessageIds),
    ...document.materials.flatMap((item) => item.evidenceMessageIds),
    ...document.experiences.flatMap((item) => item.evidenceMessageIds),
    ...document.actionItems.flatMap((item) => item.evidenceMessageIds),
    ...document.openQuestions.flatMap((item) => item.evidenceMessageIds),
    ...document.conflicts.flatMap((item) => item.evidenceMessageIds),
  ]).size;
}

onMounted(() => void refresh());
onBeforeUnmount(() => { if (pollTimer) window.clearTimeout(pollTimer); });
</script>

<template>
  <main class="group-summary-page" v-loading="loading">
    <header class="page-heading">
      <div><h1>群聊总结</h1><p>持续归档白名单群消息，整理计算机保研与推免情报。</p></div>
      <el-button @click="addGroup">添加群</el-button>
    </header>

    <el-alert v-if="loadError" :title="loadError" type="error" show-icon :closable="false" />

    <section class="summary-workspace">
      <aside class="group-rail">
        <div class="rail-title"><span>群范围</span><b>{{ state?.groups.length ?? 0 }}</b></div>
        <button
          v-for="row in state?.groups ?? []"
          :key="row.groupId"
          class="group-row"
          :class="{ active: row.groupId === selectedGroupId }"
          @click="selectGroup(row.groupId)"
        >
          <span class="group-main"><strong>{{ row.roomName }}</strong><small>{{ row.groupId }}</small></span>
          <span class="group-count"><b>{{ row.unsummarizedCount }}</b><small>待总结</small></span>
          <el-switch
            :model-value="row.enabled"
            :loading="operation === 'group-settings' && selectedGroupId === row.groupId"
            aria-label="记录群消息"
            @click.stop
            @change="toggleGroup(row, Boolean($event))"
          />
        </button>
        <div v-if="!state?.groups.length" class="rail-empty">添加群号后开始记录。</div>
      </aside>

      <div v-if="detail" class="summary-main">
        <section class="group-command">
          <div>
            <span class="eyebrow">{{ detail.group.enabled ? '正在记录' : '记录已暂停' }}</span>
            <h2>{{ detail.group.roomName }}</h2>
            <p>{{ detail.messageCount }} 条已归档消息 · {{ detail.batches.length }} 个总结批次</p>
          </div>
          <div class="command-actions">
            <el-button
              type="primary"
              :loading="operation === 'create-task' || Boolean(activeTask)"
              :disabled="Boolean(activeTask)"
              @click="createSummary('automatic')"
            >总结新增消息</el-button>
          </div>
        </section>

        <div v-if="activeTask" class="task-strip">
          <span class="pulse" />
          <strong>任务 #{{ activeTask.id }}</strong>
          <span>{{ activeTask.stage }} · {{ activeTask.messageCount }} 条消息</span>
        </div>
        <div v-else-if="detail.latestTask?.status === 'failed'" class="task-strip failed">
          <strong>最近任务失败</strong><span>{{ detail.latestTask.error?.message }}</span>
        </div>

        <section class="overview-section">
          <header class="section-line"><div><span class="eyebrow">当前总览</span><h3>{{ detail.overview?.headline ?? '等待第一次总结' }}</h3></div><span>{{ formatTime(detail.overviewUpdatedAt) }}</span></header>
          <div v-if="detail.overview" class="overview-grid">
            <div class="intel-block institutions">
              <h4>院校与项目</h4>
              <article v-for="item in detail.overview.institutions" :key="`${item.name}:${item.program}`">
                <strong>{{ item.name }}<span v-if="item.program"> · {{ item.program }}</span></strong>
                <p v-for="line in item.details" :key="line">{{ line }}</p>
                <ul><li v-for="line in [...item.deadlines, ...item.requirements]" :key="line">{{ line }}</li></ul>
                <small>证据 {{ item.evidenceMessageIds.map((id) => `#${id}`).join(' · ') }}</small>
              </article>
              <p v-if="!detail.overview.institutions.length" class="empty-copy">暂未提取到院校或项目信息。</p>
            </div>
            <div class="intel-stack">
              <div class="intel-block"><h4>行动项</h4><p v-for="item in detail.overview.actionItems" :key="item.content">{{ item.content }}<b v-if="item.deadline"> · {{ item.deadline }}</b></p><p v-if="!detail.overview.actionItems.length" class="empty-copy">暂无行动项。</p></div>
              <div class="intel-block"><h4>待核实与冲突</h4><p v-for="item in [...detail.overview.openQuestions, ...detail.overview.conflicts]" :key="item.content">{{ item.content }}</p><p v-if="!detail.overview.openQuestions.length && !detail.overview.conflicts.length" class="empty-copy">暂无待核实信息。</p></div>
              <div class="intel-block"><h4>材料与经验</h4><p v-for="item in [...detail.overview.materials, ...detail.overview.experiences]" :key="item.content">{{ item.content }}</p><p v-if="!detail.overview.materials.length && !detail.overview.experiences.length" class="empty-copy">暂无材料或经验信息。</p></div>
            </div>
            <p class="other-topics"><b>其他话题</b>{{ detail.overview.otherTopicsBrief || '无' }}</p>
          </div>
          <div v-else class="overview-empty">消息归档后，点击“总结新增消息”生成第一份当前总览。</div>
        </section>

        <section class="range-section">
          <header class="section-line"><div><span class="eyebrow">自定义范围</span><h3>重复整理任意时间段</h3></div></header>
          <div class="range-controls">
            <label>开始<input v-model="manualStart" type="datetime-local"></label>
            <label>结束<input v-model="manualEnd" type="datetime-local"></label>
            <el-button @click="previewRange">预览</el-button>
            <el-button type="primary" :disabled="!preview?.messageCount || Boolean(activeTask)" @click="createSummary('manual')">总结此范围</el-button>
          </div>
          <p v-if="preview" class="range-result">{{ preview.messageCount }} 条消息 · {{ preview.mediaCount }} 个媒体描述 · {{ formatTime(preview.startAt) }} 至 {{ formatTime(preview.endAt) }}</p>
        </section>

        <section class="history-section">
          <header class="section-line"><div><span class="eyebrow">批次历史</span><h3>已保存的总结</h3></div></header>
          <details v-for="batch in detail.batches" :key="batch.id" class="batch-row">
            <summary>
              <span><strong>#{{ batch.id }} · {{ batch.summary.headline }}</strong><small>{{ formatTime(batch.startAt) }} 至 {{ formatTime(batch.endAt) }}</small></span>
              <span class="batch-meta">{{ batch.messageCount }} 条 · {{ evidenceCount(batch.summary) }} 条证据<span v-if="batch.overlapsPrevious"> · 重叠范围</span></span>
            </summary>
            <div class="batch-body"><p v-for="item in batch.summary.actionItems" :key="item.content">{{ item.content }}</p><p v-if="batch.summary.otherTopicsBrief"><b>其他话题：</b>{{ batch.summary.otherTopicsBrief }}</p></div>
          </details>
          <p v-if="!detail.batches.length" class="empty-copy history-empty">尚无成功总结批次。</p>
        </section>

        <section class="message-section">
          <header class="section-line"><div><span class="eyebrow">最近消息</span><h3>归档证据</h3></div></header>
          <div v-for="message in messages" :key="message.id" class="message-row">
            <span class="message-id">#{{ message.id }}</span><div><strong>{{ message.senderName }}</strong><p>{{ message.text || `[${message.media.length} 个媒体描述]` }}</p></div><time>{{ formatTime(message.capturedAt) }}</time>
          </div>
          <p v-if="!messages.length" class="empty-copy history-empty">尚未记录消息。</p>
        </section>

        <details class="settings-section">
          <summary>总结设置与数据管理</summary>
          <div class="settings-body">
            <label class="prompt-field">该群提示词覆盖<textarea v-model="promptOverrideDraft" rows="5" placeholder="留空时使用全局提示词" /></label>
            <el-button :loading="operation === 'group-settings'" @click="savePromptOverride">保存群设置</el-button>
            <el-button type="danger" plain @click="clearData">永久清除该群总结数据</el-button>
          </div>
        </details>
      </div>

      <div v-else class="summary-placeholder">从左侧选择一个群，或添加新的群号。</div>
    </section>

    <details class="global-settings">
      <summary>全局默认提示词</summary>
      <div><textarea v-model="defaultPromptDraft" rows="5" /><el-button type="primary" :loading="operation === 'default-prompt'" @click="saveDefaultPrompt">保存默认提示词</el-button></div>
    </details>
  </main>
</template>

<style scoped>
.group-summary-page{max-width:1480px;margin:0 auto;padding:28px 32px 64px}.page-heading{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:22px}.page-heading h1{margin:0;font-size:25px;letter-spacing:-.03em}.page-heading p{margin:7px 0 0;color:var(--muted);font-size:13px}.summary-workspace{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:640px;border:1px solid var(--line);border-radius:14px;background:#fff;overflow:hidden}.group-rail{border-right:1px solid var(--line);background:#f8fafc}.rail-title{display:flex;justify-content:space-between;padding:18px;color:#657083;font-size:12px;font-weight:700}.rail-title b{color:#9aa4b2}.group-row{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:10px;padding:13px 15px;border:0;border-left:3px solid transparent;color:var(--ink);background:transparent;text-align:left;transition:.16s ease}.group-row:hover{background:#f0f4fa}.group-row.active{border-left-color:var(--accent);background:#eaf0ff}.group-main,.group-count{display:grid;gap:3px}.group-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.group-main small,.group-count small{color:#8b94a3;font-size:10px}.group-count{text-align:right}.group-count b{color:#4969bd;font-size:13px}.rail-empty{padding:40px 18px;color:#8b94a3;font-size:12px;text-align:center}.summary-main{min-width:0}.group-command{display:flex;justify-content:space-between;align-items:center;padding:24px 28px;border-bottom:1px solid var(--line)}.eyebrow{display:block;margin-bottom:5px;color:#71809a;font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.group-command h2,.section-line h3{margin:0;letter-spacing:-.015em}.group-command h2{font-size:20px}.group-command p{margin:7px 0 0;color:var(--muted);font-size:12px}.task-strip{display:flex;align-items:center;gap:10px;padding:11px 28px;color:#35558f;background:#edf3ff;font-size:12px}.task-strip.failed{color:#9c3949;background:#fff0f2}.pulse{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 0 rgba(60,103,227,.4);animation:pulse 1.4s infinite}@keyframes pulse{70%{box-shadow:0 0 0 7px rgba(60,103,227,0)}}.overview-section,.range-section,.history-section,.message-section{padding:26px 28px;border-bottom:1px solid var(--line)}.section-line{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:19px}.section-line h3{font-size:16px}.section-line>span{color:#969eaa;font-size:11px}.overview-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(260px,.8fr);gap:26px}.intel-block h4{margin:0 0 12px;color:#536177;font-size:11px;letter-spacing:.06em}.intel-block article{padding:14px 0;border-top:1px solid #edf0f4}.intel-block article:first-of-type{border-top:0;padding-top:0}.intel-block article strong{font-size:14px}.intel-block article strong span{color:#66758f;font-weight:600}.intel-block p,.intel-block li{color:#4f5969;font-size:12px;line-height:1.65}.intel-block article p{margin:7px 0}.intel-block ul{margin:7px 0;padding-left:18px}.intel-block article small{color:#8993a3;font-size:10px}.intel-stack{display:grid;align-content:start;gap:20px;padding-left:25px;border-left:1px solid var(--line)}.intel-stack .intel-block p{margin:7px 0}.other-topics{grid-column:1/-1;margin:0;padding-top:16px;border-top:1px solid var(--line);color:#687386;font-size:12px}.other-topics b{margin-right:10px;color:#465166}.overview-empty{padding:46px 0;color:#8d96a5;text-align:center;font-size:12px}.empty-copy{color:#99a1ad!important;font-size:12px!important}.range-controls{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}.range-controls label{display:grid;gap:6px;color:#697386;font-size:11px}.range-controls input{height:32px;padding:0 9px;border:1px solid #dcdfe6;border-radius:6px;color:#384253;background:#fff}.range-result{margin:13px 0 0;color:#61708a;font-size:12px}.batch-row{border-top:1px solid var(--line)}.batch-row summary{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:15px 2px;cursor:pointer;list-style:none}.batch-row summary::-webkit-details-marker{display:none}.batch-row summary>span:first-child{display:grid;gap:5px}.batch-row summary strong{font-size:12px}.batch-row summary small,.batch-meta{color:#8993a2;font-size:10px}.batch-body{padding:0 20px 16px;border-left:2px solid #dce5fb;color:#505b6d;font-size:12px}.history-empty{padding:18px 0}.message-row{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;padding:12px 0;border-top:1px solid #eef1f4}.message-id{color:#7484a0;font:11px "SFMono-Regular",monospace}.message-row strong{font-size:12px}.message-row p{margin:4px 0 0;color:#5f6877;font-size:12px;line-height:1.55}.message-row time{color:#9aa2ae;font-size:10px}.settings-section,.global-settings{margin:20px 28px;border:1px solid var(--line);border-radius:9px}.settings-section summary,.global-settings summary{padding:13px 15px;color:#59657a;font-size:12px;font-weight:700;cursor:pointer}.settings-body,.global-settings>div{display:flex;align-items:flex-end;gap:10px;padding:0 15px 15px}.prompt-field{display:grid;flex:1;gap:7px;color:#697386;font-size:11px}.prompt-field textarea,.global-settings textarea{width:100%;padding:10px;border:1px solid #dcdfe6;border-radius:7px;resize:vertical}.global-settings{margin:20px 0 0;background:#fff}.global-settings>div textarea{flex:1}.summary-placeholder{display:grid;place-items:center;min-height:640px;color:#9099a8;font-size:13px}@media(max-width:900px){.group-summary-page{padding:20px 16px 48px}.summary-workspace{grid-template-columns:1fr}.group-rail{border-right:0;border-bottom:1px solid var(--line);max-height:300px;overflow:auto}.overview-grid{grid-template-columns:1fr}.intel-stack{padding-left:0;border-left:0}.global-settings>div,.settings-body{align-items:stretch;flex-direction:column}.global-settings textarea{min-height:130px}.message-row{grid-template-columns:42px minmax(0,1fr)}.message-row time{grid-column:2}}@media(prefers-reduced-motion:reduce){.pulse{animation:none}}
</style>
