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
  route: string;
  modelView: string;
  usage: string;
  boundary: string;
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

export const requestAttachmentExamples = [
  {
    label: '当前消息',
    role: 'user',
    content: [
      '[',
      '  { "type": "text", "text": "[speaker_id=10001 speaker_name=\\"小明\\"] 看图并核对 PDF" },',
      '  { "type": "image_url", "image_url": { "url": "https://…/screen.png" } },',
      '  { "type": "file_url", "file_url": { "url": "https://…/需求说明.pdf", "mimeType": "application/pdf" } }',
      ']',
    ].join('\n'),
  },
  {
    label: '再次提到历史附件',
    role: 'system',
    content: [
      '历史附件引用上下文：默认只保留引用、元数据和处理后文本；除非显式调用 qqbot_attachment_replay，否则不要假定已经看到原件。',
      '- att_pdf01 | PDF | 需求说明.pdf | 820.0 KiB | 发送者=小明 | 可回放=file_url',
      '  处理结果：这是 PDF 中已经提取并截断到本轮上限的正文……',
    ].join('\n'),
  },
] as const;

export const requestAttachmentGuides: RequestAttachmentGuide[] = [
  {
    kind: 'image',
    label: '图片',
    route: '当前消息进入“当前输入”；历史图片先进入附件引用，按需回放原图。',
    modelView: '当前轮是 user content 中的 image_url；Responses 模式会转换为 input_image。历史轮默认只有附件 ref、文件名、大小和发送者。',
    usage: '支持视觉的模型可以识别画面、文字、界面布局、物体与相互关系；需要重新查看历史原图时可调用 qqbot_attachment_replay。',
    boundary: '模型档案未通过视觉能力探测时图像会被丢弃；历史引用本身不等于模型已经看到原图。',
  },
  {
    kind: 'pdf',
    label: 'PDF',
    route: '当前消息作为文件输入；归档时同时提取 PDF 文本，历史引用优先提供文本摘录。',
    modelView: '当前轮在 Responses 模式中是 input_file(file_url, filename)。历史轮显示附件 ref、元数据和可用的 PDF 提取文本。',
    usage: '模型可以阅读支持的原始 PDF，或依据提取文本进行总结、问答、引用和内容核对；需要原件时可按 ref 回放 file_url。',
    boundary: '扫描版 PDF 没有可提取文本时只能依赖 Provider 的文件读取能力；本块不会自动执行 OCR。',
  },
  {
    kind: 'text',
    label: '文本与 JSON',
    route: '当前消息作为文件输入；归档时保存 UTF-8 文本摘录。',
    modelView: '当前轮是 input_file 或 file_url；历史轮的附件引用会附带截断后的 text excerpt。',
    usage: '模型可以阅读、检索、概括、比对和引用文本内容，也能按文本理解 JSON 等结构化数据。',
    boundary: '只按 UTF-8 文本处理并限制摘录长度；二进制内容或错误编码不会被可靠解释。',
  },
  {
    kind: 'audio',
    label: '语音与音频',
    route: '归档后优先通过 ASR 转成文本，再替换当前消息中的音频部分。',
    modelView: '有转写时是 text: “音频附件 att_… 转写：…”；无转写时只有 [attachment ref=… kind=audio]。',
    usage: '模型依据转写内容回答、总结和提取信息；历史引用与回放也优先返回转写文本。',
    boundary: '当前链路不向模型承诺原始声学信息，语气、音色、背景声和说话人分离可能不可见。',
  },
  {
    kind: 'video',
    label: '视频',
    route: '保存为视频附件；当前输入保留 video_url，历史需要原件时回放为 file_url。',
    modelView: '模型得到视频或文件句柄，以及附件 ref、文件名、MIME、大小和发送者等元数据。',
    usage: '只有 Provider 与模型支持对应视频/文件输入时才能直接读取原件。',
    boundary: '当前系统不自动抽帧、不自动提取字幕，也不保证所选模型能够理解视频内容。',
  },
  {
    kind: 'file',
    label: '其他文件',
    route: '保存为通用文件附件；当前输入和历史回放使用 file_url。',
    modelView: '模型得到文件句柄和元数据；没有通用二进制内容转文本。',
    usage: 'Provider 支持该文件类型时，模型可以直接读取；否则只能根据文件名、类型、大小和用户说明判断下一步。',
    boundary: '压缩包、Office 文件和未知 MIME 当前没有统一解析器，文件已被保存不代表模型已经理解内容。',
  },
];

export const contextBlockGuides: Record<GuidedContextBlockType, ContextBlockGuide> = {
  chatHistory: {
    summary: '读取当前会话已保存的消息。每条用户消息开启一个完整轮次，后续回复和工具结果归入该轮；系统从最新轮次向前保留，放不下的整轮舍弃。',
  },
  requestDocuments: {
    summary: '把运行时提供的文本 Document 放在聊天历史之后，作为本次回答的低权限参考材料。每份文档会携带 id、metadata 和正文；空文档跳过，达到本块上限后停止加入后续文档。',
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
