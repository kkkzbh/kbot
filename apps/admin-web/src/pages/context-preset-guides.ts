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

export const contextBlockGuides: Record<GuidedContextBlockType, ContextBlockGuide> = {
  chatHistory: {
    summary: '读取当前会话已保存的消息。每条用户消息开启一个完整轮次，后续回复和工具结果归入该轮；系统从最新轮次向前保留，放不下的整轮舍弃。',
  },
  requestDocuments: {
    summary: '把本次请求携带的文件、附件解析结果或其他临时文档作为参考材料交给模型。',
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
