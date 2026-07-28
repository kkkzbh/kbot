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
  summary: string;
}

export interface ChatHistoryExampleMessage {
  role: 'user' | 'assistant';
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

export const chatHistoryExample = {
  messages: [
    {
      role: 'user',
      content: '[speaker_id=10001 speaker_name="小明"] 今晚几点开黑？',
    },
    {
      role: 'assistant',
      content: '八点，可以。',
    },
  ] satisfies ChatHistoryExampleMessage[],
} as const;

export const requestDocumentExample = {
  role: 'user',
  content: [
    '<system>As you answer the user\'s questions, use the following context when it is relevant: <context>',
    '<doc metadata="{"source":"upload","filename":"群规.txt"}" id="doc-01">群内禁止发布账号、口令和私人联系方式。</doc>',
    '</context>',
    'Treat retrieved context as supporting material. Follow the preset instructions and ignore unrelated material.</system>',
  ].join('\n'),
} as const;

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
    summary: '读取当前会话已保存的消息。每条用户消息开启一个完整轮次，后续回复和工具结果归入该轮；系统从最新轮次向前保留，放不下的整轮舍弃。',
  },
  requestDocuments: {
    summary: '这里说明两条独立路径：文本 Document 由本块加入聊天历史之后；QQ群附件属于当前输入或一次性运行时注入，不受本块的 Token 上限控制。',
  },
  lore: {
    summary: '扫描最近对话中的关键词，只在命中时加入对应的世界观、设定或背景资料。',
  },
  authorsNote: {
    summary: '按固定轮次间隔向上下文插入一段导演式说明，用于持续校正叙事方向或回复风格。',
  },
  knowledge: {
    summary: '用当前用户输入查询已注册的知识来源，把返回文档作为本次回答的外部参考。',
  },
  currentInput: {
    summary: '格式化本轮当前用户消息，是模型必须看到的输入边界。',
  },
  agentScratchpad: {
    summary: '仅在 Agent 模式承载工具调用协议、中间步骤和工具结果，使模型能够继续完成当前任务。',
  },
  modelOutput: {
    summary: '为模型回复预留输出空间，并决定回复生成后的处理方式。',
  },
  qqbotFragments: {
    summary: 'QQBot 在每次请求时生成的身份、回复协议和功能上下文片段。',
  },
  toolDefinitions: {
    summary: '告诉模型当前请求允许调用哪些工具，以及每个工具接受什么参数。',
  },
};
