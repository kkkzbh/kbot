<script setup lang="ts">
import { computed, type Component } from 'vue';
import {
  ArrowDown,
  BookOpen,
  Brain,
  CheckCircle2,
  Heart,
  MessageCircle,
  Paperclip,
  Server,
  ShieldCheck,
  Sparkles,
  User,
  Wrench,
} from '@lucide/vue';

interface ReadableItem {
  label: string;
  title: string;
  content: string;
  kind?: string;
  alt?: string;
}

interface InlinePart {
  text: string;
  strong: boolean;
}

interface MarkdownBlock {
  type: 'heading' | 'paragraph' | 'unordered' | 'ordered';
  level?: number;
  lines: InlinePart[][];
}

interface RoleDocument {
  label: string;
  blocks: MarkdownBlock[];
}

interface DocumentPreview {
  id: string;
  filename: string;
  source: string;
  content: string;
}

interface RuntimeSection extends ReadableItem {
  entries: Array<{ key: string; value: string }>;
  lines: string[];
  view: 'skills' | 'rules' | 'metadata' | 'state' | 'attachment' | 'capabilities' | 'text';
  skills: Array<{ name: string; description: string }>;
}

interface CapabilityEntry {
  name: string;
  description: string;
  source: string;
}

interface CapabilityGroup {
  key: 'tools' | 'mcp' | 'skills';
  label: string;
  icon: Component;
  entries: CapabilityEntry[];
}

interface AgentProcessStep {
  phase: 'decision' | 'result';
  label: string;
  title: string;
  callId: string;
  entries: Array<{ key: string; value: string }>;
  result: Array<{ title: string; summary: string }>;
}

const props = defineProps<{
  value: unknown;
  emptyLabel?: string;
  kind?: string;
}>();

const roleLabels: Record<string, string> = {
  system: '系统', human: '用户', user: '用户', ai: '模型', assistant: '模型',
  tool: '工具', native: '内置工具', mcp: 'MCP', option: '生成配置', file: '附件',
};

const outboundLabels: Record<string, string> = {
  message: '文字消息', structured_block: '结构内容', image: '图片', meme: '表情', voice: '语音',
};

const runtimeTitleLabels: Record<string, string> = {
  'Context Interpretation Protocol': '上下文解释协议',
  'User Turn Metadata': '本轮用户信息',
  'Sakiko Relationship State': '关系状态',
  'Recent Attachments': '最近附件',
  'QQ Native Feature Capabilities': 'QQ 能力',
};

const runtimeKeyLabels: Record<string, string> = {
  user_name: '用户',
  local_time: '本地时间',
  timezone: '时区',
  relation: '关系',
  activeProactiveThreads: '进行中的主动话题',
  eventResult: '最近事件结果',
};

function runtimeKeyLabel(key: string): string {
  return runtimeKeyLabels[key] ?? key;
}

const processKeyLabels: Record<string, string> = {
  query: '查询内容',
  limit: '返回数量',
};

function processKeyLabel(key: string): string {
  return processKeyLabels[key] ?? key;
}

function runtimeIcon(view: RuntimeSection['view']): Component {
  if (view === 'skills') return Sparkles;
  if (view === 'rules') return ShieldCheck;
  if (view === 'metadata') return User;
  if (view === 'state') return Heart;
  if (view === 'attachment') return Paperclip;
  if (view === 'capabilities') return MessageCircle;
  return BookOpen;
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

function readableText(value: unknown): string {
  return printable(value).replace(/^\[speaker_id=[^\s]+\s+speaker_name="([^"]+)"\]\s*/, '$1：');
}

function messageContent(value: unknown): string {
  if (!Array.isArray(value)) return readableText(value);
  return value.map((part) => {
    if (!part || typeof part !== 'object') return printable(part);
    const record = part as Record<string, unknown>;
    if (record.type === 'text') return readableText(record.text);
    if (record.type === 'file_url' && record.file_url && typeof record.file_url === 'object') {
      const file = record.file_url as Record<string, unknown>;
      return `附件：${printable(file.url)}\n类型：${printable(file.mimeType)}`;
    }
    return printable(record);
  }).filter(Boolean).join('\n\n');
}

function inlineParts(source: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let cursor = 0;
  for (const match of source.matchAll(/\*\*(.+?)\*\*/g)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: source.slice(cursor, index), strong: false });
    parts.push({ text: match[1], strong: true });
    cursor = index + match[0].length;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), strong: false });
  return parts.length ? parts : [{ text: source, strong: false }];
}

function markdownBlocks(source: string): MarkdownBlock[] {
  const result: MarkdownBlock[] = [];
  const paragraph: string[] = [];
  let list: { type: 'unordered' | 'ordered'; lines: InlinePart[][] } | null = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    result.push({ type: 'paragraph', lines: [inlineParts(paragraph.join(' '))] });
    paragraph.length = 0;
  };
  const flushList = () => {
    if (!list) return;
    result.push({ type: list.type, lines: list.lines });
    list = null;
  };

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (!line) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      result.push({ type: 'heading', level: heading[1].length, lines: [inlineParts(heading[2])] });
    } else if (unordered || ordered) {
      flushParagraph();
      const type = unordered ? 'unordered' : 'ordered';
      if (list !== null && (list as { type: 'unordered' | 'ordered' }).type !== type) flushList();
      list ??= { type, lines: [] };
      list.lines.push(inlineParts((unordered ?? ordered)![1]));
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return result;
}

function objectRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

const roleDocuments = computed<RoleDocument[]>(() => objectRows(props.value).map((message) => ({
  label: roleLabels[String(message.role ?? '')] ?? '内容',
  blocks: markdownBlocks(messageContent(message.content)),
})));

const requestDocuments = computed<DocumentPreview[]>(() => {
  const source = objectRows(props.value).map((message) => printable(message.content)).join('\n');
  const documents: DocumentPreview[] = [];
  for (const match of source.matchAll(/<doc\s+([^>]*)>([\s\S]*?)<\/doc>/g)) {
    const attributes = match[1];
    documents.push({
      id: attributes.match(/\bid="([^"]+)"/)?.[1] ?? '',
      filename: attributes.match(/"filename"\s*:\s*"([^"]+)"/)?.[1] ?? '未命名文档',
      source: attributes.match(/"source"\s*:\s*"([^"]+)"/)?.[1] === 'upload' ? '用户上传' : '检索结果',
      content: match[2].trim(),
    });
  }
  return documents;
});

function outboundItem(value: Record<string, unknown>): ReadableItem {
  const kind = typeof value.type === 'string' ? value.type : 'message';
  return {
    label: outboundLabels[kind] ?? kind,
    title: '',
    content: typeof value.content === 'string' ? value.content : '',
    kind,
    alt: typeof value.alt === 'string' ? value.alt : '',
  };
}

function nativeOutputItems(value: Record<string, unknown>): ReadableItem[] {
  if (value.decision === 'no_reply') return [{ label: '不回复', title: '', content: '本轮不发送消息。', kind: 'no_reply' }];
  if (!Array.isArray(value.outbound_messages)) return [{ label: '模型回复', title: '', content: printable(value), kind: 'message' }];
  return objectRows(value.outbound_messages).map(outboundItem);
}

function chatReplyItems(source: string): ReadableItem[] {
  if (!source.startsWith('CHAT_REPLY_V1 ')) return [{ label: '文字消息', title: '', content: source, kind: 'message' }];
  if (/^DECISION no_reply$/m.test(source)) return [{ label: '不回复', title: '', content: '本轮不发送消息。', kind: 'no_reply' }];
  const result: ReadableItem[] = [];
  for (const match of source.matchAll(/^BEGIN ([^\n]+)\n([\s\S]*?)^END$/gm)) {
    const kind = match[1];
    const body = match[2];
    const content = body.split('\n').filter((line) => line.startsWith('|')).map((line) => line.slice(1)).join('\n');
    result.push({
      label: outboundLabels[kind] ?? kind,
      title: '',
      content,
      kind,
      alt: kind === 'image' ? content : '',
    });
  }
  return result.length ? result : [{ label: '模型回复', title: '', content: source, kind: 'message' }];
}

function capabilityItems(value: unknown): ReadableItem[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return ([['tools', 'Tool'], ['mcp', 'MCP'], ['skills', 'Skill']] as const).flatMap(([key, label]) => (
    objectRows(record[key]).map((row) => ({
      label,
      title: printable(row.name),
      content: [printable(row.description), key === 'skills' ? `加载：${row.mode === 'full' ? '完整内容' : row.mode === 'description' ? '说明' : '关闭'}` : ''].filter(Boolean).join('\n'),
    }))
  ));
}

const capabilityGroups = computed<CapabilityGroup[]>(() => {
  if (!props.value || typeof props.value !== 'object' || Array.isArray(props.value)) return [];
  const record = props.value as Record<string, unknown>;
  return ([
    { key: 'tools', label: '内置工具', icon: Wrench },
    { key: 'mcp', label: 'MCP 工具', icon: Server },
    { key: 'skills', label: 'Skills', icon: Sparkles },
  ] as const).map((group) => ({
    ...group,
    entries: objectRows(record[group.key]).map((row) => ({
      name: printable(row.name),
      description: printable(row.description),
      source: Array.isArray(row.providers) && row.providers.length
        ? row.providers.map(printable).join('、')
        : group.key === 'mcp' && row.server
          ? printable(row.server)
          : '',
    })),
  }));
});

function pairsFromObject(value: unknown): Array<{ key: string; value: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, entry]) => ({
    key,
    value: printable(entry),
  }));
}

const agentProcessSteps = computed<AgentProcessStep[]>(() => objectRows(props.value).flatMap<AgentProcessStep>((message): AgentProcessStep[] => {
  const toolCalls = objectRows(message.toolCalls);
  if (toolCalls.length) {
    return toolCalls.map((call) => ({
      phase: 'decision' as const,
      label: '模型决策',
      title: `调用 ${printable(call.name)}`,
      callId: printable(call.id),
      entries: pairsFromObject(call.args),
      result: [],
    }));
  }
  if (message.role === 'tool') {
    let parsed: unknown = message.content;
    try { parsed = JSON.parse(printable(message.content)); } catch { parsed = message.content; }
    const resultRecord = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    const resultItems = objectRows(resultRecord.items).map((item) => ({
      title: printable(item.title) || printable(message.name),
      summary: printable(item.summary) || printable(item.content),
    }));
    return [{
      phase: 'result' as const,
      label: '工具返回',
      title: printable(message.name),
      callId: printable(message.toolCallId),
      entries: resultItems.length ? [] : pairsFromObject(parsed),
      result: resultItems,
    }];
  }
  return [];
}));

function recordItem(value: Record<string, unknown>): ReadableItem {
  const role = typeof value.role === 'string' ? value.role : '';
  const name = typeof value.name === 'string' ? value.name : '';
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls : [];
  const sections = [messageContent(value.content)];
  if (toolCalls.length) sections.push(printable(toolCalls));
  if (role === 'tool' && typeof value.toolCallId === 'string') sections.unshift(`调用 ID：${value.toolCallId}`);
  return { label: roleLabels[role] ?? (role || '内容'), title: name, content: sections.filter(Boolean).join('\n\n') };
}

function runtimeItem(value: Record<string, unknown>): ReadableItem {
  const content = printable(value.content);
  if (content.includes('<available_skills>')) {
    const skills = [...content.matchAll(/<skill>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<description>(.*?)<\/description>[\s\S]*?<\/skill>/g)];
    return { label: 'Skills', title: '可用技能', content: skills.map((match) => `${match[1]}：${match[2]}`).join('\n') };
  }
  if (content.includes('[qqbot-context]')) {
    const kind = content.match(/^kind:\s*(.+)$/m)?.[1] ?? '';
    const title = content.match(/^title:\s*(.+)$/m)?.[1] ?? '';
    const payload = content.match(/^payload:\s*\n([\s\S]*?)^\[\/qqbot-context\]$/m)?.[1] ?? '';
    return {
      label: kind === 'runtime_contract' ? '规则' : kind === 'assistant_state' ? '状态' : '参考',
      title: runtimeTitleLabels[title] ?? title,
      content: payload.replace(/^\s{2}/gm, '').trim(),
    };
  }
  return recordItem(value);
}

function runtimeSection(item: ReadableItem, index: number): RuntimeSection {
  let entries: Array<{ key: string; value: string }> = [];
  try {
    const parsed = JSON.parse(item.content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      entries = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({ key, value: printable(value) }));
    }
  } catch {
    entries = [];
  }
  const lines = entries.length
    ? []
    : item.content.split('\n').map((line) => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  const view = item.label === 'Skills'
    ? 'skills'
    : item.title === '上下文解释协议'
      ? 'rules'
      : item.title === '本轮用户信息'
        ? 'metadata'
        : item.title === '关系状态'
          ? 'state'
          : item.title === '最近附件'
            ? 'attachment'
            : item.title === 'QQ 能力'
              ? 'capabilities'
              : 'text';
  const skills = view === 'skills'
    ? lines.map((line) => {
        const separator = line.indexOf('：');
        return separator > 0
          ? { name: line.slice(0, separator), description: line.slice(separator + 1) }
          : { name: `Skill ${index + 1}`, description: line };
      })
    : [];
  return { ...item, entries, lines, view, skills };
}

const items = computed<ReadableItem[]>(() => {
  if (props.kind === 'modelOutput') {
    if (props.value && typeof props.value === 'object' && !Array.isArray(props.value)) return nativeOutputItems(props.value as Record<string, unknown>);
    return chatReplyItems(printable(props.value));
  }
  if (props.kind === 'toolDefinitions') return capabilityItems(props.value);
  if (Array.isArray(props.value)) return objectRows(props.value).map(recordItem);
  if (props.value && typeof props.value === 'object') return [{ label: 'JSON', title: '', content: printable(props.value) }];
  const content = printable(props.value);
  return content ? [{ label: '内容', title: '', content }] : [];
});

const runtimeSections = computed<RuntimeSection[]>(() => objectRows(props.value).map(runtimeItem).map(runtimeSection));
</script>

<template>
  <section class="readable-preview" :class="`readable-${kind ?? 'generic'}`">
    <div v-if="kind === 'role' && roleDocuments.length" class="role-documents">
      <article v-for="(document, documentIndex) in roleDocuments" :key="documentIndex" class="markdown-document">
        <div class="document-role">{{ document.label }}</div>
        <template v-for="(block, blockIndex) in document.blocks" :key="blockIndex">
          <component :is="`h${Math.min(block.level ?? 2, 3)}`" v-if="block.type === 'heading'">
            <template v-for="(part, partIndex) in block.lines[0]" :key="partIndex"><strong v-if="part.strong">{{ part.text }}</strong><template v-else>{{ part.text }}</template></template>
          </component>
          <p v-else-if="block.type === 'paragraph'">
            <template v-for="(part, partIndex) in block.lines[0]" :key="partIndex"><strong v-if="part.strong">{{ part.text }}</strong><template v-else>{{ part.text }}</template></template>
          </p>
          <component :is="block.type === 'ordered' ? 'ol' : 'ul'" v-else>
            <li v-for="(line, lineIndex) in block.lines" :key="lineIndex"><template v-for="(part, partIndex) in line" :key="partIndex"><strong v-if="part.strong">{{ part.text }}</strong><template v-else>{{ part.text }}</template></template></li>
          </component>
        </template>
      </article>
    </div>

    <div v-else-if="kind === 'requestDocuments' && requestDocuments.length" class="document-list">
      <article v-for="document in requestDocuments" :key="document.id" class="document-preview">
        <header><span class="file-mark">文</span><div><strong>{{ document.filename }}</strong><span>{{ document.source }}<template v-if="document.id"> · {{ document.id }}</template></span></div></header>
        <p>{{ document.content }}</p>
      </article>
    </div>

    <div v-else-if="kind === 'qqbotFragments' && runtimeSections.length" class="runtime-map">
      <header class="runtime-map-head">
        <strong>运行时注入</strong>
        <b>{{ runtimeSections.length }} 段</b>
      </header>
      <div class="runtime-lane" aria-label="注入顺序">
        <template v-for="(section, index) in runtimeSections" :key="index">
          <span><component :is="runtimeIcon(section.view)" :size="16" />{{ section.title }}</span>
          <ArrowDown v-if="index < runtimeSections.length - 1" :size="14" class="lane-arrow" />
        </template>
      </div>
      <article v-for="(section, index) in runtimeSections" :key="index" class="runtime-section" :class="`runtime-view-${section.view}`">
        <header class="runtime-section-head">
          <span><component :is="runtimeIcon(section.view)" :size="18" /></span>
          <div><strong>{{ section.title }}</strong><small>第 {{ index + 1 }} 段</small></div>
        </header>

        <div v-if="section.view === 'skills'" class="runtime-skill-list">
          <span v-for="skill in section.skills" :key="skill.name"><Sparkles :size="14" />{{ skill.name }}</span>
        </div>
        <ol v-else-if="section.view === 'rules'" class="rule-checklist">
          <li v-for="(line, lineIndex) in section.lines.filter((line) => line !== '上下文解释协议：')" :key="lineIndex"><CheckCircle2 :size="18" />{{ line }}</li>
        </ol>
        <dl v-else-if="section.entries.length" class="runtime-facts">
          <template v-for="entry in section.entries" :key="entry.key"><dt>{{ runtimeKeyLabel(entry.key) }}</dt><dd>{{ entry.value === 'null' ? '无' : entry.value }}</dd></template>
        </dl>
        <div v-else-if="section.view === 'attachment'" class="attachment-preview">
          <span class="attachment-icon">PDF</span><div><strong>{{ section.lines[0]?.split('|')[2]?.trim() || '最近附件' }}</strong><p>{{ section.lines.slice(1).join(' ') }}</p></div>
        </div>
        <div v-else-if="section.view === 'capabilities'" class="capability-chips">
          <span v-for="capability in section.lines.join('、').replace('当前会话支持', '').replace('。', '').split('、')" :key="capability">{{ capability }}</span>
        </div>
        <div v-else class="runtime-prose"><p v-for="(line, lineIndex) in section.lines" :key="lineIndex">{{ line }}</p></div>
      </article>
    </div>

    <div v-else-if="kind === 'toolDefinitions' && capabilityGroups.length" class="capability-catalog">
      <header class="catalog-head"><strong>本轮可用能力</strong></header>
      <div class="capability-summary">
        <div v-for="group in capabilityGroups" :key="group.key"><component :is="group.icon" :size="19" /><b>{{ group.entries.length }}</b><span>{{ group.label }}</span></div>
      </div>
      <section v-for="group in capabilityGroups" :key="group.key" class="capability-group">
        <header><span class="group-marker"><component :is="group.icon" :size="17" /></span><strong>{{ group.label }}</strong><b>{{ group.entries.length }}</b></header>
        <div v-if="group.entries.length" class="capability-rows">
          <div v-for="entry in group.entries" :key="entry.name" class="capability-row">
            <component :is="group.icon" :size="15" />
            <strong>{{ entry.name }}</strong>
            <span v-if="entry.source" class="capability-source">{{ entry.source }}</span>
          </div>
        </div>
        <p v-else class="capability-empty">本轮没有启用 {{ group.label }}</p>
      </section>
    </div>

    <div v-else-if="kind === 'agentScratchpad' && agentProcessSteps.length" class="agent-process">
      <header class="process-head"><strong>Agent 执行过程</strong><b>{{ agentProcessSteps.length }} 步</b></header>
      <article v-for="(step, index) in agentProcessSteps" :key="`${step.callId}-${step.phase}`" class="process-step">
        <div class="process-rail"><span><Brain v-if="step.phase === 'decision'" :size="16" /><Wrench v-else :size="16" /></span></div>
        <div class="process-body">
          <header><span>{{ step.label }}</span><strong>{{ step.title }}</strong></header>
          <dl v-if="step.entries.length">
            <template v-for="entry in step.entries" :key="entry.key"><dt>{{ processKeyLabel(entry.key) }}</dt><dd>{{ entry.value }}</dd></template>
          </dl>
          <div v-if="step.result.length" class="process-results">
            <div v-for="result in step.result" :key="result.title"><strong>{{ result.title }}</strong><p>{{ result.summary }}</p></div>
          </div>
          <div v-if="index < agentProcessSteps.length - 1" class="process-handoff">写回上下文</div>
        </div>
      </article>
    </div>

    <div v-else-if="kind === 'modelOutput' && items.length" class="qq-preview">
      <div class="qq-scene-head"><strong>QQ 中的实际输出</strong><span>{{ items.length }} 条</span></div>
      <article v-for="(item, index) in items" :key="index" class="qq-row">
        <div class="qq-avatar">AI</div>
        <div class="qq-message">
          <span class="message-kind">{{ item.label }}</span>
          <div v-if="item.kind === 'image'" class="media-card"><span class="media-symbol">▧</span><strong>{{ item.alt || '生成图片' }}</strong></div>
          <div v-else-if="item.kind === 'meme'" class="meme-card"><span>☺</span><strong>{{ item.content || '表情' }}</strong></div>
          <div v-else-if="item.kind === 'voice'" class="voice-card"><span class="voice-wave">▮ ▮▮ ▮▮▮ ▮▮ ▮</span><strong>{{ item.content || '语音消息' }}</strong></div>
          <div v-else-if="item.kind === 'structured_block'" class="structured-card"><p v-for="(line, lineIndex) in item.content.split('\n')" :key="lineIndex">{{ line }}</p></div>
          <p v-else class="message-text">{{ item.content }}</p>
        </div>
      </article>
    </div>

    <div v-else-if="items.length === 0" class="readable-empty">{{ emptyLabel ?? '当前没有内容' }}</div>
    <template v-else>
      <article v-for="(item, index) in items" :key="index" class="readable-item">
        <header><span>{{ item.label }}</span><strong v-if="item.title">{{ item.title }}</strong></header>
        <pre v-if="item.content">{{ item.content }}</pre>
      </article>
    </template>
  </section>
</template>

<style scoped>
.readable-preview { min-height: 100%; padding: 28px 34px 48px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--ink); }
.readable-item + .readable-item, .markdown-document + .markdown-document { margin-top: 30px; padding-top: 26px; border-top: 1px solid var(--line); }
.readable-item header, .runtime-stage header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.readable-item header span, .runtime-stage header span, .document-role, .message-kind { padding: 3px 8px; border-radius: 5px; color: var(--accent); background: var(--accent-soft); font-size: 12px; font-weight: 600; }
.readable-item header strong, .runtime-stage header strong { font-size: 14px; font-weight: 600; }
.readable-item pre { margin: 0; overflow-wrap: anywhere; font: 14px/1.8 var(--font-sans, system-ui, sans-serif); white-space: pre-wrap; }
.readable-empty { min-height: 360px; display: grid; place-items: center; font-size: 14px; }

.document-role { display: inline-block; margin-bottom: 20px; }
.markdown-document { max-width: 820px; }
.markdown-document h1, .markdown-document h2, .markdown-document h3 { margin: 26px 0 10px; line-height: 1.35; }
.markdown-document h1:first-of-type, .markdown-document h2:first-of-type, .markdown-document h3:first-of-type { margin-top: 0; }
.markdown-document h1 { font-size: 24px; }.markdown-document h2 { font-size: 19px; }.markdown-document h3 { font-size: 16px; }
.markdown-document p, .markdown-document li { font-size: 15px; line-height: 1.85; }
.markdown-document p { margin: 0 0 14px; }.markdown-document ul, .markdown-document ol { margin: 8px 0 18px; padding-left: 24px; }

.document-list { max-width: 860px; display: grid; gap: 16px; }
.document-preview { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.document-preview header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--surface-soft); }
.document-preview header div { display: grid; gap: 3px; }.document-preview header strong { font-size: 14px; }.document-preview header span { font-size: 12px; color: var(--ink); }
.file-mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 7px; color: var(--accent) !important; background: var(--accent-soft); font-weight: 700; }
.document-preview > p { margin: 0; padding: 22px 20px 26px; font-size: 15px; line-height: 1.9; }

.runtime-map, .capability-catalog, .agent-process { max-width: 960px; }
.runtime-map-head, .catalog-head, .process-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
.runtime-map-head > div, .process-head > div { display: grid; gap: 5px; }
.runtime-map-head strong, .catalog-head strong, .process-head strong { font-size: 18px; }
.runtime-map-head span, .catalog-head span, .process-head span { font-size: 13px; color: var(--ink); }
.runtime-map-head > b, .process-head > b { min-width: 46px; padding: 6px 10px; border-radius: 6px; color: var(--accent); background: var(--accent-soft); text-align: center; font-size: 13px; }
.runtime-lane { display: flex; align-items: center; overflow-x: auto; gap: 9px; margin: 18px 0 8px; padding-bottom: 8px; }
.runtime-lane > span { display: flex; align-items: center; gap: 7px; min-width: max-content; padding: 7px 9px; border-radius: 6px; background: var(--surface-soft); font-size: 12px; font-weight: 600; }
.runtime-lane > span svg { color: var(--accent); }.lane-arrow { flex: 0 0 auto; color: var(--accent); transform: rotate(-90deg); }
.runtime-section { display: grid; grid-template-columns: 190px minmax(0, 1fr); padding: 22px 0; border-bottom: 1px solid var(--line); animation: readable-in .2s ease both; }
.runtime-section-head { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-content: start; gap: 11px; padding-right: 24px; }
.runtime-section-head > span { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 8px; color: var(--accent); background: var(--accent-soft); }
.runtime-section-head > div { display: grid; gap: 4px; }.runtime-section-head strong { font-size: 14px; line-height: 1.35; }.runtime-section-head small { font-size: 11px; font-weight: 600; }
.runtime-skill-list { display: flex; flex-wrap: wrap; gap: 8px; align-content: start; }
.runtime-skill-list > span { display: inline-flex; align-items: center; gap: 7px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; font-size: 12px; font-weight: 600; }.runtime-skill-list svg { color: var(--accent); }
.rule-checklist { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }.rule-checklist li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 9px; line-height: 1.65; }.rule-checklist svg { margin-top: 3px; color: var(--accent); }
.runtime-facts, .process-body dl { display: grid; grid-template-columns: minmax(130px, .32fr) minmax(0, 1fr); margin: 0; }.runtime-facts dt, .runtime-facts dd, .process-body dt, .process-body dd { margin: 0; padding: 10px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.55; }.runtime-facts dt, .process-body dt { font-weight: 600; }
.attachment-preview { display: flex; align-items: center; gap: 14px; padding: 15px; border: 1px solid var(--line); border-radius: 8px; }.attachment-icon { width: 46px; height: 52px; display: grid; place-items: center; border-radius: 6px; color: white; background: var(--accent); font-size: 11px; font-weight: 800; }.attachment-preview div { display: grid; gap: 6px; }.attachment-preview p { margin: 0; font-size: 13px; line-height: 1.55; }
.capability-chips { display: flex; flex-wrap: wrap; gap: 8px; }.capability-chips span { padding: 8px 11px; border: 1px solid var(--accent); border-radius: 6px; color: var(--accent); font-size: 13px; font-weight: 600; }.runtime-prose p { margin: 0 0 8px; line-height: 1.7; }

.capability-summary { display: grid; grid-template-columns: repeat(3, 1fr); margin: 18px 0 8px; border: 1px solid var(--line); border-radius: 8px; }.capability-summary > div { display: flex; align-items: center; justify-content: center; gap: 9px; padding: 18px; }.capability-summary > div + div { border-left: 1px solid var(--line); }.capability-summary svg, .capability-summary b { color: var(--accent); }.capability-summary b { font-size: 24px; }.capability-summary span { font-size: 13px; font-weight: 600; }
.capability-group { display: grid; grid-template-columns: 150px minmax(0, 1fr); padding: 24px 0; border-bottom: 1px solid var(--line); animation: readable-in .2s ease both; }.capability-group > header { display: grid; grid-template-columns: 32px minmax(0, 1fr); align-content: start; align-items: center; gap: 8px; }.capability-group > header > b { grid-column: 2; font-size: 12px; }.group-marker { grid-row: span 2; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 7px; color: white; background: var(--accent); }
.capability-rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }.capability-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 9px; min-width: 0; padding: 10px 11px; border: 1px solid var(--line); border-radius: 7px; }.capability-row svg { flex: 0 0 auto; color: var(--accent); }.capability-row strong { font-size: 13px; overflow-wrap: anywhere; }.capability-source { padding-left: 9px; border-left: 1px solid var(--line); color: var(--accent); font-size: 11px; font-weight: 700; white-space: nowrap; }.capability-empty { margin: 7px 0; font-size: 13px; }

.process-head { margin-bottom: 10px; }.process-step { display: grid; grid-template-columns: 54px minmax(0, 1fr); min-height: 150px; animation: readable-in .2s ease both; }.process-rail { position: relative; display: flex; justify-content: center; }.process-rail::after { content: ''; position: absolute; top: 39px; bottom: 0; width: 1px; background: var(--accent); }.process-step:last-child .process-rail::after { display: none; }.process-rail span { width: 32px; height: 32px; display: grid; place-items: center; z-index: 1; border-radius: 50%; color: white; background: var(--accent); font-size: 12px; font-weight: 700; }
.process-body { position: relative; padding: 3px 0 30px 12px; }.process-body > header { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: center; margin-bottom: 16px; }.process-body > header > span { color: var(--accent); font-size: 12px; font-weight: 700; }.process-body > header > strong { font-size: 16px; }
.process-results { border-left: 3px solid var(--accent); padding: 12px 16px; background: var(--surface-soft); }.process-results div { display: grid; gap: 6px; }.process-results p { margin: 0; line-height: 1.65; }.process-handoff { position: absolute; left: -27px; bottom: 6px; padding: 4px 8px; color: var(--accent); background: var(--surface); font-size: 11px; font-weight: 700; transform: translateX(-50%); white-space: nowrap; }

@keyframes readable-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

.readable-modelOutput { max-width: none; background: #f5f7fb; }
.qq-preview { max-width: 760px; margin: 0 auto; }
.qq-scene-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.qq-scene-head span { font-size: 13px; }
.qq-row { display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: start; gap: 10px; margin-bottom: 18px; }
.qq-avatar { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px; color: white; background: var(--accent); font-size: 11px; font-weight: 700; }
.qq-message { justify-self: start; max-width: 600px; }.message-kind { display: inline-block; margin-bottom: 6px; background: transparent; padding-left: 0; }
.message-text, .structured-card, .media-card, .voice-card { margin: 0; padding: 12px 15px; border: 1px solid var(--line); border-radius: 4px 12px 12px; background: white; font-size: 15px; line-height: 1.65; }
.structured-card p { margin: 3px 0; }.media-card { min-width: 260px; min-height: 120px; display: grid; place-items: center; gap: 8px; background: linear-gradient(145deg, #eef3ff, white); }
.media-symbol { color: var(--accent); font-size: 32px; }.meme-card { width: 122px; height: 122px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 20px; background: white; }.meme-card span { font-size: 46px; }.meme-card strong { font-size: 13px; }
.voice-card { display: flex; align-items: center; gap: 12px; min-width: 270px; }.voice-wave { color: var(--accent); letter-spacing: 1px; white-space: nowrap; }

@media (max-width: 720px) { .readable-preview { padding: 22px 20px 36px; }.runtime-section, .capability-group { grid-template-columns: 1fr; gap: 16px; }.runtime-facts, .process-body dl { grid-template-columns: 1fr; }.runtime-facts dd, .process-body dd { padding-top: 0; }.media-card { min-width: 200px; } }
</style>
