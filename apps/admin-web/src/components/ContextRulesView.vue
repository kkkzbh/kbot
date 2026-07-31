<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  type ContextPresetDefinitionV1,
  type ContextPresetPreviewResponse,
  type RolePresetDefinitionV1,
} from '@contracts';
import {
  chatHistoryExample,
  requestAttachmentHistory,
  requestDocumentExample,
} from '@/pages/context-preset-guides';

type PipelineStage =
  | 'system_prompts'
  | 'after_system_prompts'
  | 'lore'
  | 'chat_history'
  | 'long_history'
  | 'injections'
  | 'input'
  | 'scratchpad'
  | 'provider_tools'
  | 'output';

type StageDefinition = {
  id: PipelineStage;
  index: string;
  title: string;
  summary: string;
  blockTypes: string[];
  rules: string[];
  rawLabel: string;
  raw: string;
  exampleLabel?: string;
  example?: string;
  agentSection?: 'mcp' | 'skills' | 'tools';
};

const props = defineProps<{
  preset: ContextPresetDefinitionV1 | null;
  role: RolePresetDefinitionV1 | null;
  preview: ContextPresetPreviewResponse | null;
}>();

const emit = defineEmits<{
  editBlock: [id: string];
  navigateAgent: [section: 'mcp' | 'skills' | 'tools'];
}>();

const selectedStage = ref<PipelineStage>('system_prompts');

function storedBlock(type: string) {
  return props.preset?.blocks.find((block) => block.type === type);
}

function blockNames(types: string[]): string[] {
  return props.preview?.blocks
    .filter((block) => types.includes(block.type))
    .map((block) => block.type) ?? [];
}

const stages = computed<StageDefinition[]>(() => {
  const roleMessages = props.role?.messages ?? [];
  const input = storedBlock('currentInput');
  const scratchpad = storedBlock('agentScratchpad');
  const output = storedBlock('modelOutput');
  const lore = props.preset?.blocks.filter((block) => block.type === 'lore') ?? [];
  const longHistory = props.preset?.blocks.filter((block) => (
    block.type === 'requestDocuments' || block.type === 'knowledge'
  )) ?? [];
  return [
    {
      id: 'system_prompts',
      index: '01',
      title: 'System prompts',
      summary: '角色与最高优先级系统说明。',
      blockTypes: ['role'],
      rules: [
        'Role block 读取当前 Role preset，展开 request variables 后按 messages 原顺序生成消息。',
        '角色消息只包含 system / user / assistant 与正文，消息顺序直接表达示例对话。',
        'Role 是 Context template 的第一个 Base block。',
      ],
      rawLabel: '当前 Role 配置（渲染前；不会作为这段 JSON 发送）',
      raw: JSON.stringify(roleMessages, null, 2),
    },
    {
      id: 'after_system_prompts',
      index: '02',
      title: 'Runtime system instructions',
      summary: 'Skills 和 QQBot 的 trusted system 片段。',
      blockTypes: ['qqbotFragments'],
      rules: [
        'description mode 的 Skill 只有在 Skill Loader Tool 通过 effective Tool policy 时才列入 <available_skills>。',
        'full mode Skill 每次请求生成独立 <skill_content> SystemMessage；通过 Skill Loader 加载的 Skill 在当前会话继续注入。',
        'QQBot persona_core 与 runtime_contract 片段必须 trusted，并以 system role 注入。',
      ],
      rawLabel: 'Renderer 完整示例：1 个 description Skill，skillsDir=/skills，cwd=/workspace',
      raw: [
        '<available_skills>',
        'You may use available computer-use capabilities when the environment provides them. Working directory: /workspace.',
        '',
        'Skills dir (local): /skills',
        'When a task installs or updates a skill, place it under <skills-dir>/<skill-name>/ and keep the entry file at <skill-dir>/SKILL.md.',
        '',
        'You can load extra instructions with the skill tool when the current task matches one of the skills below.',
        'Use a skill early when it gives you a better workflow, checklist, or domain-specific procedure.',
        '',
        '  <skill>',
        '    <name>web-research</name>',
        '    <description>Search the web and cite primary sources.</description>',
        '    <location>/skills/web-research</location>',
        '  </skill>',
        '',
        'Use the exact skill name when calling the skill tool.',
        '</available_skills>',
      ].join('\n'),
      exampleLabel: 'Renderer 完整示例：同一 Skill 使用 full mode',
      example: [
        '<skill_content name="web-research">',
        'The following skill remains active for the current conversation.',
        'Description: Search the web and cite primary sources.',
        'Directory: /workspace/.skills/web-research',
        '',
        'Search primary sources first.',
        'Cite every factual claim.',
        '',
        '<skill_resources>',
        '  <file>references/sources.md</file>',
        '</skill_resources>',
        '</skill_content>',
      ].join('\n'),
      agentSection: 'skills',
    },
    {
      id: 'lore',
      index: '03',
      title: 'Lore',
      summary: '关键词命中时固定放在角色区域之后。',
      blockTypes: ['lore'],
      rules: [
        'Lore 是紧随 Role 的固定 Base block 区域；多个 Lore block 保持模板中的原顺序。',
        '每个 Lore block 扫描最近对话关键词，命中条目后才生成消息。',
        'Lore 受各自 budgetPriority 与 maxTokens 约束。',
      ],
      rawLabel: '当前模板中的 Lore 配置',
      raw: JSON.stringify(lore, null, 2),
    },
    {
      id: 'chat_history',
      index: '04',
      title: 'Chat history',
      summary: '当前会话中已经保存的完整轮次。',
      blockTypes: ['chatHistory'],
      rules: [
        '从最新轮次向前装入；一个 human 消息及其后续 ai / tool 消息构成完整轮次。',
        'Token 不足时丢弃整个旧轮次，不截断单条消息来凑预算。',
        '内部 semantic role 保持 human / ai / tool / system；Provider adapter 再映射到对应 API role。',
        '进入 assembled messages 后仍会受到模型总 context limit 的最终裁剪。',
      ],
      rawLabel: '完整语义示例：历史中保留一个两消息轮次',
      raw: JSON.stringify(chatHistoryExample.messages, null, 2),
    },
    {
      id: 'long_history',
      index: '05',
      title: 'Documents and knowledge',
      summary: '请求文档和按当前输入检索出的知识。',
      blockTypes: ['requestDocuments', 'knowledge'],
      rules: [
        'requestDocuments 处理本次请求携带的 Document；knowledge 用当前输入查询配置的知识来源。',
        '两者受各自 budgetPriority 与 maxTokens 约束。',
        '文档内容属于参考材料，不能提升为 system authority。',
      ],
      rawLabel: '默认 longMemoryPrompt 的完整渲染示例（换行与 content 均按 renderer 输出）',
      raw: JSON.stringify(requestDocumentExample, null, 2),
      exampleLabel: '当前模板中的配置',
      example: JSON.stringify(longHistory, null, 2),
    },
    {
      id: 'injections',
      index: '06',
      title: 'Injections',
      summary: 'Authors note 与 QQBot 低权限实时参考。',
      blockTypes: ['authorsNote', 'qqbotFragments'],
      rules: [
        'Authors note 固定在 Current input 前，按 insertFrequency 判断本轮是否生成消息。',
        'QQBot reference 与 assistant_state 使用 human role，按 authority、TTL、注册顺序排序并去重。',
      ],
      rawLabel: '完整渲染示例：trusted persona_core',
      raw: [
        '[qqbot-context]',
        'kind: persona_core',
        'title: Current identity',
        'trust: trusted',
        'payload:',
        '  你是 QQBot，当前发言者是小明。',
        '[/qqbot-context]',
      ].join('\n'),
      exampleLabel: '完整渲染示例：untrusted reference',
      example: [
        '[qqbot-context]',
        'kind: reference',
        'title: Attachment reference',
        'trust: untrusted',
        'payload:"用户提到了附件 att_pdf01"',
        '[/qqbot-context]',
      ].join('\n'),
    },
    {
      id: 'input',
      index: '07',
      title: 'Current input',
      summary: '本轮用户消息与本轮附件。',
      blockTypes: ['currentInput'],
      rules: [
        'inputFormat 为 null 时，inputMessage.content 不做文字格式化，直接进入模型。',
        'inputFormat 有值时，先用 sender_id、sender、prompt、date、time 等变量渲染。',
        '本轮图片、PDF 和文件作为多模态 content parts 保留在同一条 user message 中。',
      ],
      rawLabel: input?.type === 'currentInput' && input.inputFormat
        ? '当前 inputFormat 原文'
        : '当前规则',
      raw: input?.type === 'currentInput' && input.inputFormat
        ? input.inputFormat
        : 'inputFormat = null\ninputMessage.content = originContent',
      exampleLabel: '完整语义示例：未启用 inputFormat 的文本输入',
      example: JSON.stringify({
        role: 'human',
        content: '[speaker_id=10001 speaker_name="小明"] 帮我总结刚发的 PDF',
      }, null, 2),
    },
    {
      id: 'scratchpad',
      index: '08',
      title: 'Agent scratchpad',
      summary: 'Tool calls、Tool results 与 Agent 中间步骤。',
      blockTypes: ['agentScratchpad'],
      rules: [
        '只有 Agent loop 产生中间步骤时才有内容。',
        'assistant tool_call 与对应 tool result 保持 call id 关联，供下一轮模型继续推理。',
        '历史附件投影位于 after_scratchpad；需要原件时再调用 qqbot_attachment_replay。',
      ],
      rawLabel: '当前 scratchpad 配置',
      raw: JSON.stringify(scratchpad ?? null, null, 2),
      exampleLabel: '完整语义示例：after_scratchpad 的历史附件投影',
      example: JSON.stringify({
        role: requestAttachmentHistory.role,
        content: requestAttachmentHistory.projection,
      }, null, 2),
      agentSection: 'tools',
    },
    {
      id: 'provider_tools',
      index: '↗',
      title: 'Provider tools[]',
      summary: 'Native Tools 与 MCP Tools 的 name、description、input schema。',
      blockTypes: ['toolDefinitions'],
      rules: [
        'Plugin、全局 Tool、Main Agent、route/scope、authority、selector 与 runtime availability 依次求交集。',
        '通过筛选的 Native Tool 与 MCP Tool 一起进入 provider tools[]。',
        'Plugin 自身不生成 prompt；MCP server instructions、resources、prompts 当前也不注入。',
      ],
      rawLabel: '完整语义示例：一个通过筛选的 Tool definition',
      raw: JSON.stringify({
        name: 'lookup',
        description: 'Look up a record by id.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      }, null, 2),
      exampleLabel: '当前会话的真实 definitions',
      example: '在下方“实际请求示例”选择一次请求，可查看该请求捕获的全部 Tool definitions。',
      agentSection: 'tools',
    },
    {
      id: 'output',
      index: '09',
      title: 'Model output boundary',
      summary: '输出 Token 预算与生成后的 handler。',
      blockTypes: ['modelOutput'],
      rules: [
        'modelOutput 不进入 messages[]，它为生成结果预留 maxOutputTokens。',
        'postHandler 在模型生成后运行，不改变本次模型输入。',
      ],
      rawLabel: '当前 modelOutput 配置',
      raw: JSON.stringify(output ?? null, null, 2),
    },
  ];
});

const selected = computed(() => (
  stages.value.find((stage) => stage.id === selectedStage.value) ?? stages.value[0]
));

function editSelected(): void {
  const stage = selected.value;
  if (!stage) return;
  const block = props.preview?.blocks.find((item) => stage.blockTypes.includes(item.type));
  if (block && block.source === 'stored') emit('editBlock', block.id);
}
</script>

<template>
  <section class="rules-view">
    <header class="rules-head">
      <div>
        <h2>通用输入规则</h2>
        <p>左侧是稳定的 assembly contract。Base blocks 依当前模板顺序组装；runtime instructions、injections 和 after_scratchpad 按固定插入点加入。</p>
        <div class="reading-key"><span>当前配置：渲染前</span><span>完整示例：按 renderer 原样生成</span><span>实际请求：见页面下方</span></div>
      </div>
      <div class="budget-line">
        <span>Input budget <strong>{{ preview?.inputBudgetTokens ?? 'runtime' }}</strong></span>
        <span>Output budget <strong>{{ preview?.outputBudgetTokens ?? '—' }}</strong></span>
      </div>
    </header>

    <div class="rules-grid">
      <nav class="pipeline" aria-label="模型上下文 pipeline">
        <button
          v-for="stage in stages"
          :key="stage.id"
          type="button"
          :class="{ active: selectedStage === stage.id, parallel: stage.id === 'provider_tools' }"
          @click="selectedStage = stage.id"
        >
          <span class="stage-index">{{ stage.index }}</span>
          <span class="stage-copy"><strong>{{ stage.title }}</strong><small>{{ stage.summary }}</small></span>
          <span v-if="blockNames(stage.blockTypes).length" class="stage-count">{{ blockNames(stage.blockTypes).length }}</span>
        </button>
      </nav>

      <article v-if="selected" class="rule-detail">
        <header>
          <div><small>{{ selected.id }}</small><h3>{{ selected.title }}</h3></div>
          <div class="detail-actions">
            <el-button v-if="preview?.blocks.some((block) => selected.blockTypes.includes(block.type) && block.source === 'stored')" text @click="editSelected">编辑当前配置</el-button>
            <el-button v-if="selected.agentSection" text @click="emit('navigateAgent', selected.agentSection)">Agent 设置</el-button>
          </div>
        </header>
        <ol class="rule-list">
          <li v-for="rule in selected.rules" :key="rule">{{ rule }}</li>
        </ol>
        <section class="raw-block">
          <span>{{ selected.rawLabel }}</span>
          <pre>{{ selected.raw }}</pre>
        </section>
        <section v-if="selected.example" class="raw-block example">
          <span>{{ selected.exampleLabel }}</span>
          <pre>{{ selected.example }}</pre>
        </section>
      </article>
    </div>
  </section>
</template>

<style scoped>
.rules-view{display:grid;gap:18px;max-width:1120px;margin:0 auto;color:var(--ink)}.rules-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.rules-head h2{margin:0;font-size:18px;letter-spacing:-.02em}.rules-head p{max-width:680px;margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.6}.reading-key{display:flex;flex-wrap:wrap;gap:7px 14px;margin-top:10px;color:var(--muted);font-size:10px}.reading-key span{position:relative;padding-left:9px}.reading-key span::before{position:absolute;top:50%;left:0;width:3px;height:3px;border-radius:50%;background:var(--accent);content:"";transform:translateY(-50%)}.budget-line{display:flex;gap:16px;color:var(--muted);font-size:10px;white-space:nowrap}.budget-line strong{margin-left:4px;color:var(--ink);font-weight:600}.rules-grid{display:grid;grid-template-columns:300px minmax(0,1fr);align-items:start;gap:28px}.pipeline{display:grid;border-top:1px solid var(--line)}.pipeline button{display:grid;grid-template-columns:27px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:58px;padding:8px 8px;border:0;border-bottom:1px solid var(--line);background:transparent;color:inherit;text-align:left;cursor:pointer;transition:background-color .14s ease}.pipeline button:hover,.pipeline button.active{background:color-mix(in srgb,var(--surface) 88%,var(--accent) 12%)}.pipeline button.active{box-shadow:inset 2px 0 0 var(--accent)}.pipeline button.parallel{margin-top:8px;border-top:1px dashed var(--line)}.stage-index{color:var(--muted);font-family:var(--font-mono,ui-monospace,monospace);font-size:10px}.stage-copy{display:flex;min-width:0;flex-direction:column;gap:3px}.stage-copy strong{font-size:12px}.stage-copy small{overflow:hidden;color:var(--muted);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.stage-count{display:grid;min-width:20px;height:20px;place-items:center;border:1px solid var(--line);border-radius:10px;color:var(--muted);font-size:9px}.rule-detail{display:grid;gap:20px;min-width:0}.rule-detail>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:14px;border-bottom:1px solid var(--line)}.rule-detail header small{color:var(--muted);font-family:var(--font-mono,ui-monospace,monospace);font-size:9px}.rule-detail h3{margin:3px 0 0;font-size:18px}.detail-actions{display:flex;gap:2px}.rule-list{display:grid;gap:8px;margin:0;padding-left:20px;color:var(--muted);font-size:12px;line-height:1.6}.raw-block{display:grid;gap:7px;min-width:0}.raw-block>span{color:var(--muted);font-size:10px}.raw-block pre{max-height:390px;margin:0;padding:15px;overflow:auto;border:1px solid var(--line);border-radius:7px;background:#111418;color:#d7dde6;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.raw-block.example pre{background:#171a1f}@media(max-width:850px){.rules-head{align-items:stretch;flex-direction:column}.budget-line{white-space:normal}.rules-grid{grid-template-columns:1fr}.pipeline{grid-template-columns:repeat(2,minmax(0,1fr))}.pipeline button.parallel{margin-top:0;border-top:0}}@media(max-width:560px){.pipeline{grid-template-columns:1fr}.rule-detail>header{align-items:stretch;flex-direction:column}.detail-actions{justify-content:flex-start}}
</style>
