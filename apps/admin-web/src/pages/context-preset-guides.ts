export type GuidedContextBlockType =
  | 'chatHistory'
  | 'requestDocuments'
  | 'lore'
  | 'authorsNote'
  | 'knowledge'
  | 'currentInput'
  | 'agentScratchpad'
  | 'modelOutput'
  | 'qqbotFragments'
  | 'toolDefinitions';

export interface ContextBlockGuide {
  placement: string;
  summary: string;
}

export interface ChatHistoryExampleMessage {
  role: 'human' | 'ai';
  content: string;
}

export type SupportedRequestAttachmentKind =
  | 'image'
  | 'pdf'
  | 'text'
  | 'audio'
  | 'video'
  | 'file';

export interface RequestAttachmentGuide {
  kind: SupportedRequestAttachmentKind;
  label: string;
  description: string;
}

export const qqbotFragmentRules = [
  {
    label: '生成',
    description: '每次模型请求都重新读取当前会话状态并生成，保存上下文预设时不会把动态内容写进 YAML。',
  },
  {
    label: '放置',
    description: '身份与回复协议作为 system 指令接在角色提示之后；本轮参考和助手状态放在当前输入之前，保持低权限。',
  },
  {
    label: '排序',
    description: '身份协议、运行协议、参考信息、助手状态按固定次序排列；完全相同的片段只保留一次。',
  },
  {
    label: '消费',
    description: '片段只供当前请求使用，注入后立即清除。下一次请求重新计算，不会混入上一轮的临时状态。',
  },
] as const;

export const configurableQqbotFragmentChannels = [
  {
    key: 'relationshipState',
    label: '关系状态',
    description: '关系进度、近期事件和主动话题。',
  },
  {
    key: 'attachmentReferences',
    label: '附件定位参考',
    description: '解析“刚才的文件”等历史附件指代。',
  },
  {
    key: 'nativeCapabilities',
    label: 'QQ 功能能力',
    description: '本轮可用的回复、提及与媒体能力。',
  },
] as const;

export const chatHistoryExample = {
  messages: [
    {
      role: 'human',
      content: '[speaker_id=10001 speaker_name="小明"] 今晚几点开黑？',
    },
    {
      role: 'ai',
      content: '八点，可以。',
    },
  ] satisfies ChatHistoryExampleMessage[],
} as const;

export const requestDocumentExample = {
  role: 'human',
  content: '<system>As you answer the user\'s questions, use the following context when it is relevant: <context><doc metadata="{"source":"upload","filename":"群规.txt"}" id="doc-01">群内禁止发布账号、口令和私人联系方式。</doc></context>\n\nTreat retrieved context as supporting material. Follow the preset instructions and ignore unrelated material.</system>',
} as const;

export const skillDescriptionExample = [
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
].join('\n');

export const requestAttachmentHistory = {
  injectionName: 'read_files_context',
  stage: 'after_scratchpad',
  role: 'system',
  projection: [
    '历史附件引用上下文：默认只保留引用、元数据和处理后文本；除非显式调用 qqbot_attachment_replay，否则不要假定已经看到原件。',
    '- att_pdf01 | PDF | 需求说明.pdf | 820.0 KiB | 发送者=小明 | 可回放=file_url',
    '  处理结果：这是 PDF 已提取并截断的正文……',
  ].join('\n'),
  replayCall: 'qqbot_attachment_replay({ refs: ["att_pdf01"], purpose: "查看 PDF 原件中的图表" })',
  readCall: 'read_files({ files: [{ url: "<回放返回的 file_url>" }] })',
} as const;

export const requestAttachmentGuides: RequestAttachmentGuide[] = [
  {
    kind: 'image',
    label: '图片',
    description: '本轮图片作为 image_url 放在“当前输入”，视觉模型可直接识别画面和文字。归档后不提取图片内容；历史引用只给出文件信息，模型需要原图时按引用 ID 回放，再用 read_files 读取。',
  },
  {
    kind: 'pdf',
    label: 'PDF',
    description: '本轮 PDF 作为 file_url 进入“当前输入”，Provider 会转换为文件输入。归档时提取正文，历史引用直接附带文本摘录；需要版式、图片或更完整内容时再回放原件。扫描版 PDF 当前不自动 OCR。',
  },
  {
    kind: 'text',
    label: '文本与 JSON',
    description: '本轮文件作为 file_url 进入“当前输入”。归档时保存 UTF-8 文本摘录，历史引用和回放直接返回这段文本，模型可据此检索、总结和比较；超长内容会截断。',
  },
  {
    kind: 'audio',
    label: '语音与音频',
    description: '先用 ASR 转写，本轮“当前输入”、历史引用和回放都给模型转写文本。没有转写时只保留附件引用；当前回放不会把原始音频交给模型，因此音色、语气和背景声不可用。',
  },
  {
    kind: 'video',
    label: '视频',
    description: '本轮保留 video_url。归档后不抽帧、不提取字幕，历史引用只有文件信息；回放可取回 file_url，再由 read_files 尝试读取，能否理解取决于 Provider 与模型的视频能力。',
  },
  {
    kind: 'file',
    label: '其他文件',
    description: '本轮和回放都使用 file_url。系统没有通用二进制解析器；归档后的历史引用只有文件名、类型、大小和发送者，只有 read_files 与所选模型支持该格式时才能读取原件。',
  },
];

export const contextBlockGuides: Record<GuidedContextBlockType, ContextBlockGuide> = {
  chatHistory: {
    placement: '整轮裁剪',
    summary: '按完整轮次从新到旧取用；预算不足时丢弃整轮。',
  },
  requestDocuments: {
    placement: 'human reference',
    summary: '检索文档进入 human 消息；附件走 Current input 或 runtime injection。',
  },
  lore: {
    placement: 'Role 之后 · 命中时',
    summary: '关键词命中时注入；多个 Lore 保持模板顺序。',
  },
  authorsNote: {
    placement: 'Input 之前 · 按频率',
    summary: '达到配置的轮次频率时注入。',
  },
  knowledge: {
    placement: '按当前输入检索',
    summary: '用当前输入检索已登记知识源，并计入本块预算。',
  },
  currentInput: {
    placement: '本轮输入',
    summary: '未配置格式时使用原始输入；附件保留在同一条 human 消息。',
  },
  agentScratchpad: {
    placement: 'Input 之后 · Agent only',
    summary: '保留 Tool call/result 的 call id；历史附件投影位于其后。',
  },
  modelOutput: {
    placement: '不进入 messages[]',
    summary: '只预留输出预算，并配置生成后的处理。',
  },
  qqbotFragments: {
    placement: 'Skills · QQBot context',
    summary: 'Skills 与 trusted QQBot 内容进入 system；reference 与 state 保持 human 权限。',
  },
  toolDefinitions: {
    placement: 'Provider tools[]',
    summary: 'Native 与 MCP Tool 求交集后发送；Plugin 本身不产生 prompt。',
  },
};
