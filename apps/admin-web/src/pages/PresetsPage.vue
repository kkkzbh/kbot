<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import { api, jsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

const presets = ref<any[]>([]);
const defaultPreset = ref('');
const selected = ref('');
const document = reactive<any>({ name: '', originalName: '', source: 'runtime', keywordsText: '', prompts: [] });
const loading = ref(false);
const saving = ref(false);
const runtime = useRuntimeStore();

async function load() {
  loading.value = true;
  try {
    const result = await api<any>('/presets');
    presets.value = result.presets;
    defaultPreset.value = result.defaultPreset;
    if (!selected.value && presets.value.length) await selectPreset(presets.value[0].name);
  } finally { loading.value = false; }
}

async function selectPreset(name: string) {
  selected.value = name;
  const result = await api<any>(`/presets/${encodeURIComponent(name)}`);
  Object.assign(document, {
    name: result.name,
    originalName: result.name,
    source: result.source,
    keywordsText: result.keywords.join(', '),
    prompts: result.prompts.map((item: any) => ({ ...item })),
  });
}

function createPreset() {
  selected.value = '';
  Object.assign(document, { name: '', originalName: '', source: 'runtime', keywordsText: '', prompts: [{ role: 'system', content: '' }] });
}

async function save() {
  saving.value = true;
  try {
    const result = await api<any>('/presets', {
      method: 'POST',
      body: jsonBody({
        name: document.name,
        ...(document.originalName ? { originalName: document.originalName } : {}),
        source: document.source,
        keywords: document.keywordsText.split(/[,，]/).map((item: string) => item.trim()).filter(Boolean),
        prompts: document.prompts,
      }),
    });
    selected.value = result.preset.name;
    document.originalName = result.preset.name;
    document.source = 'runtime';
    runtime.updateApply(result.apply);
    ElMessage.success('预设已保存');
    await load();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '预设保存失败'); }
  finally { saving.value = false; }
}

async function setDefault() {
  const result = await api<any>('/settings/model', { method: 'PATCH', body: jsonBody({ changes: [{ key: 'CHATLUNA_DEFAULT_PRESET', value: document.name }] }) });
  defaultPreset.value = document.name;
  runtime.updateApply(result);
  ElMessage.success('默认预设已更新，重启后生效');
}

async function remove() {
  await ElMessageBox.confirm(`删除运行时预设 ${document.name}？`, '确认删除', { type: 'warning' });
  const result = await api<any>(`/presets/${encodeURIComponent(document.name)}`, { method: 'DELETE' });
  runtime.updateApply(result.apply);
  selected.value = '';
  createPreset();
  await load();
}

function handleSave() { save(); }
onMounted(() => { load(); window.addEventListener('admin-save', handleSave); });
onBeforeUnmount(() => window.removeEventListener('admin-save', handleSave));
</script>

<template>
  <PageHeader :saving="saving" @save="save"><template #actions><el-button @click="createPreset">新建预设</el-button></template></PageHeader>
  <div class="preset-layout">
    <aside class="panel preset-list">
      <div class="panel-head"><div><h2>预设列表</h2><p>{{ presets.length }} 个可用预设</p></div></div>
      <button v-for="item in presets" :key="item.name" :class="{ active: selected === item.name }" @click="selectPreset(item.name)">
        <span><strong>{{ item.name }}</strong><small>{{ item.source === 'runtime' ? '运行时' : '仓库内置' }}</small></span><el-tag v-if="item.name === defaultPreset" size="small">默认</el-tag>
      </button>
    </aside>
    <article class="panel preset-editor">
      <template v-if="document.prompts.length">
        <div class="panel-head"><div><h2>{{ document.originalName ? `编辑 ${document.originalName}` : '新建预设' }}</h2><p>保存会写入 runtime preset 目录</p></div><div><el-button v-if="document.name && document.name !== defaultPreset" size="small" @click="setDefault">设为默认</el-button><el-button v-if="document.source === 'runtime' && document.originalName" size="small" type="danger" plain @click="remove">删除</el-button></div></div>
        <div class="panel-body">
          <el-form label-position="top">
            <div class="grid-2 compact"><el-form-item label="预设名称"><el-input v-model="document.name" /></el-form-item><el-form-item label="触发关键词"><el-input v-model="document.keywordsText" placeholder="使用逗号分隔" /></el-form-item></div>
            <div class="prompt-head"><strong>Prompt messages</strong><el-button size="small" @click="document.prompts.push({role:'system',content:''})">添加消息</el-button></div>
            <div v-for="(prompt,index) in document.prompts" :key="index" class="prompt-row">
              <el-select v-model="prompt.role" style="width:130px"><el-option v-for="role in ['system','user','assistant','tool']" :key="role" :value="role" /></el-select>
              <el-input v-model="prompt.content" type="textarea" :autosize="{minRows:3,maxRows:12}" />
              <el-button text type="danger" @click="document.prompts.splice(index,1)">移除</el-button>
            </div>
          </el-form>
        </div>
      </template>
      <EmptyState v-else title="选择或新建一个预设" description="内置预设保存后会生成 runtime override，不会修改仓库文件。" />
    </article>
  </div>
</template>

<style scoped>
.preset-layout { display:grid; grid-template-columns:260px minmax(0,1fr); gap:18px; }.preset-list { overflow:hidden; align-self:start; }.preset-list > button { width:100%; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 16px; border:0; border-bottom:1px solid #f0f2f5; color:#475164; background:#fff; text-align:left; }.preset-list > button:hover,.preset-list > button.active { background:#f5f8ff; }.preset-list > button.active { box-shadow:inset 3px 0 #3c67e3; }.preset-list strong,.preset-list small { display:block; }.preset-list strong { font-size:12px; }.preset-list small { margin-top:3px; color:#929aa8; font-size:9px; }.preset-editor { min-height:460px; overflow:hidden; }.compact { gap:14px; }.prompt-head { display:flex; align-items:center; justify-content:space-between; margin:4px 0 12px; font-size:12px; }.prompt-row { display:flex; align-items:flex-start; gap:10px; margin-bottom:12px; }
@media(max-width:800px){.preset-layout{grid-template-columns:1fr}.preset-list{max-height:270px;overflow:auto}.prompt-row{flex-wrap:wrap}.prompt-row .el-textarea{width:100%}}
</style>
