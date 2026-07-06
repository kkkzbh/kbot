import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
  }

  const schemaChain = new Proxy(() => schemaChain, {
    get: () => schemaChain,
    apply: () => schemaChain,
  }) as any;
  const Schema = new Proxy({}, {
    get: () => schemaChain,
  }) as any;

  return {
    Context: class {},
    Logger: MockLogger,
    Schema,
    h: {
      text: (content: string) => ({
        type: 'text',
        attrs: { content },
        toString: () => content,
      }),
      image: (src: unknown, mime?: string) => ({ type: 'image', attrs: { src, mime } }),
      audio: (src: unknown) => ({ type: 'audio', attrs: { src } }),
    },
  };
});

import { mainChatRuntimeState } from '../src/plugins/shared/llm/main-chat-runtime.js';
import { resolveMainChatRuntimeProfileFromEnv } from '../src/plugins/shared/llm/main-chat-tabs.js';
import {
  buildProactiveTaskMarkdown,
} from '../src/plugins/affinity/proactive-task.js';
import type { AffinityRandomGenerationInput } from '../src/plugins/affinity/proactive-types.js';
import { generateAffinityProactiveViaChatLuna } from '../src/plugins/affinity/proactive-chatluna.js';
import { createVoiceRuntimeConfig } from '../src/plugins/reply/voice/generation.js';

const NOW = Date.UTC(2026, 5, 17, 6, 0, 0);

function input(overrides: Partial<AffinityRandomGenerationInput> = {}): AffinityRandomGenerationInput {
  return {
    direction: 'local_thread',
    now: NOW,
    scopeLabel: '测试群',
    relationSummary: {
      representativeStage: 'polite',
      recentUserCount: 3,
      dominantMood: 'focused',
      highestAttentionHeat: 46,
    },
    recentTurns: [
      {
        role: 'human',
        speakerName: 'Alice',
        text: 'SCC 缩点之后为什么一定没有环？',
        observedAt: NOW - 10 * 60_000,
        source: 'realtime',
      },
      {
        role: 'human',
        speakerName: 'Bob',
        text: '因为环应该会被缩在一个点里？但我不太确定。',
        observedAt: NOW - 8 * 60_000,
        source: 'realtime',
      },
    ],
    recentMemories: [
      {
        direction: 'contest_discussion',
        messageText: '昨天那道缩点题，我还是有一点在意。',
        contextSummary: '图论问题',
        responseSummary: null,
        responses: [
          {
            speakerName: 'Alice',
            summary: '提到了 SCC 缩点后可以先画 DAG。',
            at: NOW - 23 * 60 * 60_000 - 50 * 60_000,
          },
        ],
        responderNames: ['Alice'],
        createdAt: NOW - 24 * 60 * 60_000,
        lastResponseAt: NOW - 23 * 60 * 60_000 - 50 * 60_000,
      },
    ],
    materialText: JSON.stringify({
      kind: 'contest',
      title: '缩点后的路径问题',
      summary: '有向图中把强连通分量缩成 DAG 后，判断若干路径关系。',
      sourceLabel: 'local seed',
      sourceUrl: 'https://example.com/problem',
      tags: ['graph', 'scc'],
      promptHints: ['只描述核心约束，不要给完整竞赛题面。'],
    }),
    webTopicText: JSON.stringify({
      source: 'weibo_hot',
      title: '某开源项目发布新的长期支持版本',
      fetchedAt: NOW - 2 * 60_000,
      claimStatus: 'unverified_current',
      safety: 'title_only_low_confidence',
    }),
    lastRealtimeMessageAt: NOW - 8 * 60_000,
    ...overrides,
  };
}

function createSession() {
  return {
    platform: 'onebot',
    channelId: '100',
    guildId: '100',
    userId: 'affinity-proactive',
    isDirect: false,
    bot: {
      selfId: 'bot-1',
      platform: 'onebot',
      sendMessage: vi.fn(),
    },
    state: {
      qqSticker: {
        catalog: null,
        preset: 'sakiko',
        availableCount: 1,
      },
    },
  } as any;
}

const conversation = {
  id: 'conv-temp',
  bindingKey: 'shared:onebot:bot-1:100',
  title: 'affinity-proactive-temp',
  preset: 'sakiko',
  model: 'openai/gpt-5.4-medium-thinking',
  chatMode: 'plugin',
  createdBy: 'affinity-proactive',
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  lastChatAt: new Date(NOW),
  status: 'active',
  latestMessageId: null,
  additional_kwargs: null,
  compression: null,
  archivedAt: null,
  archiveId: null,
  autoTitle: false,
};

function createTestVoiceRuntime() {
  return createVoiceRuntimeConfig({
    inputEnabled: false,
    outputEnabled: false,
    asrBaseUrl: '',
    asrApiKey: '',
    ttsBaseUrl: '',
    ttsApiKey: '',
    inputMaxSeconds: 60,
    outputMaxWords: 1000,
    outputMaxSeconds: 600,
    voiceOutputLanguage: 'auto',
    transcribeTimeoutMs: 1000,
    synthTimeoutMs: 1000,
    replyInterruptCollectWindowMs: 1000,
    replyInterruptMaxPendingInputs: 1,
    naturalTriggerEnabled: false,
    naturalTriggerGroups: '',
  });
}

function createChatLuna(responseContent: string) {
  const chat = vi.fn(async (..._args: any[]) => ({
    content: responseContent,
    additional_kwargs: {},
  }));
  return {
    chat,
    contextManager: {
      inject: vi.fn(),
    },
  };
}

function expectNoLegacyPrompt(prompt: string): void {
  expect(prompt).not.toContain('你是丰川祥子');
  expect(prompt).not.toContain('"shouldSend"');
  expect(prompt).not.toContain('输出 JSON schema');
  expect(prompt).not.toContain('最多 120');
  expect(prompt).not.toMatch(/\b\d{13}\b/u);
}

describe('affinity proactive task prompt and provider adapter', () => {
  afterEach(() => {
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({}));
  });

  it('builds local_thread Markdown task context without old custom protocol or raw timestamps', () => {
    const prompt = buildProactiveTaskMarkdown(input());

    expect(prompt).toContain('# 主动发言任务：承接未完话题');
    expect(prompt).toContain('## 最近群聊上下文');
    expect(prompt).toContain('## 局部主动事件记忆');
    expect(prompt).toContain('Alice');
    expect(prompt).toContain('SCC 缩点之后为什么一定没有环？');
    expect(prompt).toContain('2026-06-17 13:50:00 +08:00，10分钟前');
    expect(prompt).toContain('2026-06-16 14:10:00 +08:00，23小时50分钟前');
    expectNoLegacyPrompt(prompt);
    expect(prompt).not.toContain('lastResponseAt":');
  });

  it('renders every proactive direction as Markdown with direction-specific boundaries', () => {
    const cases = [
      ['daily_greeting', '# 主动发言任务：日常问候', '## 时间参考'],
      ['music_rehearsal', '# 主动发言任务：排练素材自然发言', '## 音乐素材'],
      ['contest_discussion', '# 主动发言任务：算法题讨论', '## 题目素材'],
      ['computer_knowledge', '# 主动发言任务：技术话题或代码疑问', '## 技术素材'],
      ['web_hot_topic', '# 主动发言任务：热点素材闲聊', '## 联网热点素材'],
      ['relationship_scene', '# 主动发言任务：关系氛围事件', '## 关系概况'],
    ] as const;

    for (const [direction, title, section] of cases) {
      const prompt = buildProactiveTaskMarkdown(input({ direction }));
      expect(prompt).toContain(title);
      expect(prompt).toContain(section);
      expect(prompt).toContain('## 局部主动事件记忆');
      expect(prompt).toContain('按当前 provider 回复协议返回 no_reply');
      expectNoLegacyPrompt(prompt);
    }
  });

  it('does not expose group context to music_rehearsal or web_hot_topic prompts', () => {
    const musicPrompt = buildProactiveTaskMarkdown(input({
      direction: 'music_rehearsal',
      recentMemories: [],
      materialText: JSON.stringify({
        kind: 'music',
        title: '春日影',
        summary: '旧曲、排练、键盘声部与合奏默契的话题 seed。',
        tags: ['keyboard'],
        promptHints: ['不要引用歌词，不要输出具体谱面音符。'],
      }),
    }));
    const webPrompt = buildProactiveTaskMarkdown(input({
      direction: 'web_hot_topic',
      recentMemories: [],
    }));

    expect(musicPrompt).toContain('## 音乐素材');
    expect(musicPrompt).not.toContain('## 最近群聊上下文');
    expect(musicPrompt).not.toContain('Alice');
    expect(musicPrompt).not.toContain('SCC 缩点之后为什么一定没有环？');
    expect(webPrompt).toContain('## 联网热点素材');
    expect(webPrompt).toContain('2026-06-17 13:58:00 +08:00，2分钟前');
    expect(webPrompt).not.toContain('## 最近群聊上下文');
    expect(webPrompt).not.toContain('Alice');
    expect(webPrompt).not.toContain('SCC 缩点之后为什么一定没有环？');
    expectNoLegacyPrompt(musicPrompt);
    expectNoLegacyPrompt(webPrompt);
  });

  it('renders relationship summary without internal stage names or relationship axes', () => {
    const prompt = buildProactiveTaskMarkdown(input({
      direction: 'relationship_scene',
      materialText: JSON.stringify({
        kind: 'relationship',
        title: '自然确认',
        summary: '根据近期有效回应生成一条低负担关系氛围消息。',
        tags: ['stage:polite'],
        promptHints: ['不要提系统规则。'],
      }),
    }));

    expect(prompt).toContain('## 关系概况');
    expect(prompt).toContain('主要情绪：偏专注');
    expect(prompt).toContain('注意热度：适中，避免刷存在感');
    expect(prompt).not.toContain('representativeStage');
    expect(prompt).not.toContain('stage:polite');
    expect(prompt).not.toContain('trust');
    expect(prompt).not.toContain('familiarity');
    expect(prompt).not.toContain('comfort');
    expect(prompt).not.toContain('tension');
    expectNoLegacyPrompt(prompt);
  });

  it('uses the current native StructuredReply contract and returns a transport plan', async () => {
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_OPENAI_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_OPENAI_API_KEY: 'sk-openai',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
    }));
    const chatluna = createChatLuna(JSON.stringify({
      decision: 'reply',
      outbound_messages: [
        {
          type: 'message',
          content: '前面那道缩点题，只要缩完后还能绕回来，原来就该在同一个强连通分量里。',
        },
      ],
    }));

    const result = await generateAffinityProactiveViaChatLuna({
      chatluna,
      conversation,
      session: createSession(),
      input: input(),
      requestId: 'test-native',
      runtime: createTestVoiceRuntime(),
    });

    expect(result).toEqual(expect.objectContaining({
      shouldSend: true,
      outputProtocol: 'native_chat_json_schema',
      eventTypeHint: 'answer_random_prompt',
    }));
    expect(result.transportPlan?.segments[0]).toEqual(expect.objectContaining({
      kind: 'message',
      parts: [{ kind: 'text', content: expect.stringContaining('缩点题') }],
    }));
    expect(chatluna.chat.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ id: 'conv-temp' }));
    expect(chatluna.chat.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ requestId: 'test-native' }));
    const modelMessage = chatluna.chat.mock.calls[0]?.[2] as { additional_kwargs?: Record<string, any> };
    expect(modelMessage.additional_kwargs?.qqbot_final_response_contract).toEqual(expect.objectContaining({
      protocol: 'native_chat_json_schema',
      schema: expect.objectContaining({ title: 'StructuredReply' }),
    }));
    expect(modelMessage.additional_kwargs?.qqbot_final_response_schema).toEqual(expect.objectContaining({
      title: 'StructuredReply',
    }));
    const injectedText = chatluna.contextManager.inject.mock.calls[0]?.[0]?.value
      .map((message: { content: string }) => message.content)
      .join('\n\n');
    expect(injectedText).toContain('Affinity Proactive Task');
    expect(injectedText).toContain('Structured Reply Contract');
    expect(injectedText).not.toContain('source: qqbot_affinity_proactive_task');
    expect(injectedText).not.toContain('source: qqbot_structured_reply_contract');
    const injectedMessages = chatluna.contextManager.inject.mock.calls[0]?.[0]?.value as Array<{
      additional_kwargs?: Record<string, { source?: string }>;
    }>;
    expect(injectedMessages.map((message) => message.additional_kwargs?.qqbot_context?.source)).toEqual(
      expect.arrayContaining(['qqbot_affinity_proactive_task', 'qqbot_structured_reply_contract']),
    );
  });

  it('keeps image, meme, and voice provider actions in the proactive transport plan', async () => {
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_OPENAI_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_OPENAI_API_KEY: 'sk-openai',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
    }));
    const chatluna = createChatLuna(JSON.stringify({
      decision: 'reply',
      outbound_messages: [
        { type: 'image', assetRef: 'https://example.com/rehearsal.png', alt: '排练标记' },
        { type: 'meme', content: '轻轻点头' },
        { type: 'voice', content: '这里我想再确认一下。' },
      ],
    }));

    const result = await generateAffinityProactiveViaChatLuna({
      chatluna,
      conversation,
      session: createSession(),
      input: input({ direction: 'music_rehearsal' }),
      requestId: 'test-media',
      runtime: createVoiceRuntimeConfig({
        inputEnabled: false,
        outputEnabled: true,
        asrBaseUrl: '',
        asrApiKey: '',
        ttsBaseUrl: 'https://tts.example.com',
        ttsApiKey: 'tts-key',
        inputMaxSeconds: 60,
        outputMaxWords: 1000,
        outputMaxSeconds: 600,
        voiceOutputLanguage: 'auto',
        transcribeTimeoutMs: 1000,
        synthTimeoutMs: 1000,
        replyInterruptCollectWindowMs: 1000,
        replyInterruptMaxPendingInputs: 1,
        naturalTriggerEnabled: false,
        naturalTriggerGroups: '',
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      shouldSend: true,
      eventTypeHint: 'music_help',
    }));
    expect(result.transportPlan?.segments.map((segment) => segment.kind)).toEqual(['image', 'sticker', 'voice']);
  });

  it('uses CHAT_REPLY_V1 when the current provider requires the text protocol', async () => {
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'deepseek',
      CHATLUNA_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      CHATLUNA_DEEPSEEK_API_KEY: 'sk-deepseek',
      CHATLUNA_DEEPSEEK_DEFAULT_MODEL: 'deepseek-v4-flash',
    }));
    const chatluna = createChatLuna([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN structured_block',
      'CONTENT',
      '|前面那道缩点题，可以先把“缩完后还有环”反过来想：它们仍然互相可达。',
      'END',
      'DONE abc12345',
    ].join('\n'));

    const result = await generateAffinityProactiveViaChatLuna({
      chatluna,
      conversation,
      session: createSession(),
      input: input(),
      requestId: 'test-chat-reply-v1',
      runtime: createTestVoiceRuntime(),
    });

    expect(result).toEqual(expect.objectContaining({
      shouldSend: true,
      outputProtocol: 'chat_reply_v1',
    }));
    expect(result.transportPlan?.segments[0]).toEqual(expect.objectContaining({
      kind: 'structured_block',
      content: expect.stringContaining('互相可达'),
    }));
    const modelMessage = chatluna.chat.mock.calls[0]?.[2] as { additional_kwargs?: Record<string, any> };
    expect(modelMessage.additional_kwargs?.qqbot_final_response_contract).toEqual(expect.objectContaining({
      protocol: 'chat_reply_v1',
      schema: null,
      instruction: expect.stringContaining('CHAT_REPLY_V1 <nonce>'),
    }));
    expect(modelMessage.additional_kwargs?.qqbot_final_response_instruction).toContain('CHAT_REPLY_V1 <nonce>');
    const injectedText = chatluna.contextManager.inject.mock.calls[0]?.[0]?.value
      .map((message: { content: string }) => message.content)
      .join('\n\n');
    expect(injectedText).toContain('CHAT_REPLY_V1 <nonce>');
  });

  it('maps provider no_reply to a skipped proactive generation without fallback text', async () => {
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_OPENAI_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_OPENAI_API_KEY: 'sk-openai',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
    }));
    const chatluna = createChatLuna(JSON.stringify({
      decision: 'no_reply',
      outbound_messages: null,
    }));

    const result = await generateAffinityProactiveViaChatLuna({
      chatluna,
      conversation,
      session: createSession(),
      input: input({ recentTurns: [] }),
      requestId: 'test-no-reply',
      runtime: createTestVoiceRuntime(),
    });

    expect(result).toEqual(expect.objectContaining({
      shouldSend: false,
      message: null,
      skipReason: 'provider_no_reply',
      transportPlan: null,
    }));
  });

  it('rejects missing ChatLuna contextManager instead of generating without the proactive prompt envelope', async () => {
    const chatluna = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          decision: 'reply',
          outbound_messages: [{ type: 'message', content: '这不该被调用。' }],
        }),
        additional_kwargs: {},
      })),
    };

    await expect(generateAffinityProactiveViaChatLuna({
      chatluna,
      conversation,
      session: createSession(),
      input: input(),
      requestId: 'test-missing-context-manager',
      runtime: createTestVoiceRuntime(),
    })).rejects.toThrow('affinity proactive generation requires chatluna.contextManager.');
    expect(chatluna.chat).not.toHaveBeenCalled();
  });
});
