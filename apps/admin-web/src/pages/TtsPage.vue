<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import PageHeader from '@/components/PageHeader.vue';
import { api, apiAudio, jsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

const state = ref<any | null>(null);
const botDraft = reactive<Record<string, string>>({});
const botOriginal = reactive<Record<string, string>>({});
const localDraft = reactive<Record<string, string>>({});
const localOriginal = reactive<Record<string, string>>({});
const clearBotSecret = ref(false);
const clearLocalSecret = ref(false);
const sampleText = ref('下午好。系统运行正常，需要我继续处理什么吗？');
const sampleStyle = ref('white');
const sampleUrl = ref('');
const loading = ref(false);
const saving = ref(false);
const sampleLoading = ref(false);
const runtime = useRuntimeStore();
const healthClass = computed(() => state.value?.health.status === 'ok' ? 'ok' : state.value?.health.status === 'unreachable' ? 'error' : 'warn');
const localEntries = computed(() => Object.entries(localDraft).filter(([key]) => key !== 'VOICE_TTS_API_KEY'));

function labelFor(key: string) {
  return key.replace(/^VOICE_TTS_/, '').split('_').map((part) => part[0] + part.slice(1).toLowerCase()).join(' ');
}

function hydrate(result: any) {
  state.value = result;
  for (const field of result.botFields || []) {
    botDraft[field.key] = field.value ?? '';
    botOriginal[field.key] = field.value ?? '';
  }
  for (const [key, value] of Object.entries(result.localGateway.env)) {
    localDraft[key] = typeof value === 'string' ? value : '';
    localOriginal[key] = typeof value === 'string' ? value : '';
  }
  clearBotSecret.value = false;
  clearLocalSecret.value = false;
}

async function load() {
  loading.value = true;
  try { hydrate(await api('/tts')); }
  finally { loading.value = false; }
}

async function save() {
  const botChanges: any[] = [];
  const localChanges: any[] = [];
  for (const [key, value] of Object.entries(botDraft)) {
    if (key === 'QQ_VOICE_TTS_API_KEY') {
      if (clearBotSecret.value) botChanges.push({ key, clear: true });
      else if (value) botChanges.push({ key, value });
    } else if (value !== botOriginal[key]) botChanges.push({ key, value });
  }
  if (clearLocalSecret.value) localChanges.push({ key: 'VOICE_TTS_API_KEY', clear: true });
  else if (localDraft.VOICE_TTS_API_KEY) localChanges.push({ key: 'VOICE_TTS_API_KEY', value: localDraft.VOICE_TTS_API_KEY });
  for (const [key, value] of localEntries.value) if (value !== localOriginal[key]) localChanges.push({ key, value });
  if (!botChanges.length && !localChanges.length) { ElMessage.info('当前页面没有变更'); return; }
  saving.value = true;
  try {
    const result = await api<any>('/tts', { method: 'PATCH', body: jsonBody({ botChanges, localChanges }) });
    hydrate(result.tts);
    runtime.updateApply(result.apply);
    ElMessage.success('TTS 配置已保存');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'TTS 保存失败'); }
  finally { saving.value = false; }
}

async function probe() {
  loading.value = true;
  try {
    const result = await api<any>('/tts/probe', { method: 'POST', body: '{}' });
    if (state.value) state.value.health = result.health;
    result.health.status === 'ok' ? ElMessage.success('TTS 健康探测通过') : ElMessage.warning(result.health.error || 'TTS 状态异常');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '探测失败'); }
  finally { loading.value = false; }
}

async function sample() {
  sampleLoading.value = true;
  try {
    const blob = await apiAudio('/tts/sample', { text: sampleText.value, style: sampleStyle.value });
    if (sampleUrl.value) URL.revokeObjectURL(sampleUrl.value);
    sampleUrl.value = URL.createObjectURL(blob);
    await new Promise((resolve) => setTimeout(resolve));
    const player = document.querySelector<HTMLAudioElement>('#tts-player');
    await player?.play();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '试听失败'); }
  finally { sampleLoading.value = false; }
}

function handleSave() { save(); }
onMounted(() => { load(); window.addEventListener('admin-save', handleSave); });
onBeforeUnmount(() => { window.removeEventListener('admin-save', handleSave); if (sampleUrl.value) URL.revokeObjectURL(sampleUrl.value); });
</script>

<template>
  <PageHeader :saving="saving" @save="save"><template #actions><el-button :loading="loading" @click="probe">健康探测</el-button></template></PageHeader>
  <template v-if="state">
    <section class="tts-status panel">
      <div><i class="status-dot" :class="healthClass" /><span><strong>{{ state.health.status }}</strong><small>{{ state.health.targetBaseUrl || '尚未配置目标地址' }}</small></span></div>
      <dl><div><dt>Latency</dt><dd>{{ state.health.latencyMs == null ? '—' : `${state.health.latencyMs} ms` }}</dd></div><div><dt>Device</dt><dd>{{ state.health.device || state.localGateway.resolved.device }}</dd></div><div><dt>Upstream</dt><dd>{{ state.health.running == null ? 'unknown' : state.health.running ? 'running' : 'stopped' }}</dd></div></dl>
    </section>
    <section class="form-section">
      <h2 class="section-title">机器人连接</h2>
      <el-form label-position="top" class="settings-grid">
        <el-form-item v-for="field in state.botFields" :key="field.key" :label="field.label">
          <template v-if="field.type==='secret'"><el-input v-model="botDraft[field.key]" type="password" show-password :disabled="clearBotSecret" :placeholder="field.configured ? '已配置，留空保持原值' : '输入新的 Secret'" /><el-checkbox v-if="field.configured" v-model="clearBotSecret">显式清空</el-checkbox></template>
          <el-input v-else v-model="botDraft[field.key]" />
        </el-form-item>
      </el-form>
    </section>
    <section class="form-section">
      <div class="section-head"><div><h2 class="section-title">本机 GPT-SoVITS 网关</h2><p>配置文件：<span class="mono">{{ state.localGateway.envFile }}</span></p></div><el-tag :type="state.localGateway.manageable ? 'success' : 'info'">{{ state.localGateway.manageable ? '可管理' : '只读角色' }}</el-tag></div>
      <el-form label-position="top" class="settings-grid">
        <el-form-item label="API Key"><el-input v-model="localDraft.VOICE_TTS_API_KEY" type="password" show-password :disabled="clearLocalSecret" :placeholder="state.localGateway.secretState.VOICE_TTS_API_KEY.configured ? '已配置，留空保持原值' : '输入新的 Secret'" /><el-checkbox v-if="state.localGateway.secretState.VOICE_TTS_API_KEY.configured" v-model="clearLocalSecret">显式清空</el-checkbox></el-form-item>
        <el-form-item v-for="[key] in localEntries" :key="key" :label="labelFor(key)"><el-switch v-if="['VOICE_TTS_IS_HALF','VOICE_TTS_PARALLEL_INFER'].includes(key)" v-model="localDraft[key]" active-value="true" inactive-value="false" /><el-input v-else v-model="localDraft[key]" /></el-form-item>
      </el-form>
    </section>
    <section class="form-section sample-section">
      <h2 class="section-title">流式试听</h2>
      <p class="field-help">音频以原始响应流返回，浏览器通过 Blob URL 播放。</p>
      <el-input v-model="sampleText" type="textarea" :rows="3" maxlength="500" show-word-limit />
      <div class="sample-actions"><el-segmented v-model="sampleStyle" :options="[{label:'白祥',value:'white'},{label:'黑祥',value:'black'}]" /><el-button type="primary" :loading="sampleLoading" @click="sample">生成试听</el-button><audio id="tts-player" :src="sampleUrl" controls /></div>
    </section>
  </template>
</template>

<style scoped>
.tts-status{display:flex;align-items:center;justify-content:space-between;gap:24px;max-width:960px;margin-bottom:16px;padding:18px 22px}.tts-status>div{display:flex;align-items:center;gap:12px}.tts-status strong,.tts-status small{display:block}.tts-status strong{font-size:14px;text-transform:uppercase}.tts-status small{margin-top:3px;color:var(--muted);font-size:10px}.tts-status dl{display:flex;gap:32px;margin:0}.tts-status dl div{min-width:80px}.tts-status dt{color:#939baa;font-size:9px}.tts-status dd{margin:4px 0 0;font-size:12px}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px}.section-head{display:flex;align-items:flex-start;justify-content:space-between}.section-head .section-title{margin-bottom:4px}.section-head p{margin:0 0 18px;color:var(--muted);font-size:10px}.sample-actions{display:flex;align-items:center;gap:12px;margin-top:14px}.sample-actions audio{height:34px;max-width:320px}@media(max-width:760px){.tts-status{align-items:flex-start;flex-direction:column}.tts-status dl{width:100%;justify-content:space-between;gap:8px}.settings-grid{grid-template-columns:1fr}.sample-actions{align-items:stretch;flex-direction:column}.sample-actions audio{max-width:100%}}
</style>
