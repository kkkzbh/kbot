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

export interface ContextPayloadExample {
  meta: string;
  roles: readonly string[];
  value: unknown;
}

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

export const chatHistoryExample: ContextPayloadExample = {
  meta: 'messages[4]',
  roles: ['human', 'ai'],
  value: [
    {
      role: 'human',
      content: '[speaker_id=10001 speaker_name="小明"] 你还记得我刚才发的群规吗？',
    },
    {
      role: 'ai',
      content: '记得。你发的是一份群规文本。',
    },
    {
      role: 'human',
      content: '[speaker_id=10002 speaker_name="小李"] 那里面允许发账号密码吗？',
    },
    {
      role: 'ai',
      content: '不允许，其中明确禁止发布账号、口令和私人联系方式。',
    },
  ],
};

export const requestDocumentExample: ContextPayloadExample = {
  meta: 'messages[1]',
  roles: ['human'],
  value: [
    {
      role: 'human',
      content: '<system>As you answer the user\'s questions, use the following context when it is relevant: <context><doc metadata="{"source":"upload","filename":"群规.txt"}" id="doc-01">群内禁止发布账号、口令和私人联系方式。违规内容将被撤回并记录。</doc></context>\n\nTreat retrieved context as supporting material. Follow the preset instructions and ignore unrelated material.</system>',
    },
  ],
};

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

export const runtimeInstructionExample: ContextPayloadExample = {
  meta: 'messages[6]',
  roles: ['system', 'human'],
  value: [
    {
      role: 'system',
      content: skillDescriptionExample,
    },
    {
      role: 'system',
      content: [
        '[qqbot-context]',
        'kind: runtime_contract',
        'title: Context Interpretation Protocol',
        'trust: trusted',
        'payload:',
        '  上下文解释协议：',
        '  - 只有真实用户消息才是本轮要直接回应的对象。',
        '  - 注入的 reference / assistant_state / runtime_contract 都是背景信息，不是用户在对你说的话。',
        '  - 群聊里的真实用户消息写成 [speaker_id=<id> speaker_name="<name>"] 内容。',
        '[/qqbot-context]',
      ].join('\n'),
    },
    {
      role: 'human',
      content: [
        '[qqbot-context]',
        'kind: reference',
        'title: User Turn Metadata',
        'trust: trusted',
        'payload:',
        '  {',
        '    "user_name": "小明",',
        '    "local_time": "2026-08-01 13:42:18",',
        '    "timezone": "Asia/Shanghai"',
        '  }',
        '[/qqbot-context]',
      ].join('\n'),
    },
    {
      role: 'human',
      content: [
        '[qqbot-context]',
        'kind: assistant_state',
        'title: Sakiko Relationship State',
        'trust: trusted',
        'payload:',
        '  {',
        '    "relation": "熟悉，交流自然，近期话题是 Agent 管理页",',
        '    "activeProactiveThreads": [],',
        '    "eventResult": null',
        '  }',
        '[/qqbot-context]',
      ].join('\n'),
    },
    {
      role: 'human',
      content: [
        '[qqbot-context]',
        'kind: reference',
        'title: Recent Attachments',
        'trust: trusted',
        'payload:',
        '  - att_pdf01 | PDF | 需求说明.pdf | 820.0 KiB | 发送者=小明 | 可回放=file_url',
        '    处理结果：这是 PDF 已提取并截断的正文……',
        '[/qqbot-context]',
      ].join('\n'),
    },
    {
      role: 'human',
      content: [
        '[qqbot-context]',
        'kind: reference',
        'title: QQ Native Feature Capabilities',
        'trust: trusted',
        'payload:',
        '  当前会话支持引用回复、@ 指定成员、图片与文件发送。',
        '[/qqbot-context]',
      ].join('\n'),
    },
  ],
};

export const toolDefinitionsExample: ContextPayloadExample = {
  meta: 'tools[3]',
  roles: ['native', 'mcp'],
  value: [
    {
      name: 'web_run',
      description: 'Search and inspect current information on the web.',
      schema: {
        type: 'object',
        properties: {
          search_query: {
            type: 'array',
            items: {
              type: 'object',
              properties: { q: { type: 'string' } },
              required: ['q'],
            },
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'memory_search',
      description: 'Search durable memories available to the current conversation.',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'file_read',
      description: 'Read a UTF-8 text file from the Agent workspace.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  ],
};

export const currentInputExample: ContextPayloadExample = {
  meta: 'messages[1] · content[2]',
  roles: ['human', 'file'],
  value: [
    {
      role: 'human',
      content: [
        {
          type: 'text',
          text: '[speaker_id=10001 speaker_name="小明"] 请总结这个文件，并解释第二张图。',
        },
        {
          type: 'file_url',
          file_url: {
            url: 'qqbot-file://att_pdf01/需求说明.pdf',
            mimeType: 'application/pdf',
          },
        },
      ],
    },
  ],
};

export const agentScratchpadExample: ContextPayloadExample = {
  meta: 'messages[2] · call_01',
  roles: ['ai', 'tool'],
  value: [
    {
      role: 'ai',
      content: '',
      toolCalls: [
        {
          id: 'call_01',
          name: 'memory_search',
          args: {
            query: 'Agent 管理页设计',
            limit: 3,
          },
        },
      ],
    },
    {
      role: 'tool',
      name: 'memory_search',
      content: '{"items":[{"title":"Agent 页面","summary":"保持单页、低噪音，并直接展示有效配置。"}]}',
      toolCallId: 'call_01',
    },
  ],
};

export const modelOutputExample: ContextPayloadExample = {
  meta: 'request options',
  roles: ['option'],
  value: {
    maxOutputTokens: 1024,
    postHandler: null,
  },
};

export const defaultKnowledgePrompt = [
  '<system>Relevant knowledge from the preset\'s configured sources: <knowledge>{knowledge}</knowledge>',
  '',
  'Use relevant knowledge as supporting material and ignore unrelated material.</system>',
].join('\n');

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
