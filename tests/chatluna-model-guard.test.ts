import { describe, expect, it, vi } from 'vitest';
import {
  buildProactiveOpeningState,
  resolveUserTurnIntentState,
} from '../src/plugins/reply/prompt/turn-context.js';
import {
  buildModelReplyOutputContract,
  buildModelRequestOverrides,
} from '../src/plugins/shared/llm/index.js';
import {
  buildChatReplyV1OutputContractLines,
  buildNativeJsonOutputContractLines,
  buildReplySemanticContractLines,
} from '../src/plugins/shared/llm/reply-output-contract.js';
import { buildStructuredReplyJsonSchema } from '../src/plugins/shared/llm/structured-reply-schema.js';
import { syncRoomModelToMainBinding } from '../src/plugins/model-guard/hot-switch.js';
import {
  deriveOneBotAvatarUrl,
  resolveSessionAvatarUrl,
  resolveSessionDisplayName,
  resolveSessionQqNick,
} from '../src/plugins/shared/session/index.js';
import { createTestModelRuntime } from './model-runtime-fixture.js';

function assertStrictRequiredForAllObjects(schema: unknown): void {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      const keys = Object.keys(properties as Record<string, unknown>);
      expect(Array.isArray(record.required)).toBe(true);
      expect([...(record.required as string[])].sort()).toEqual([...keys].sort());
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else {
        visit(value);
      }
    }
  };

  visit(schema);
}

describe('canonical main chat reply contract', () => {
  it('documents generic image final replies without tool-specific coupling', () => {
    const textProtocolContract = buildChatReplyV1OutputContractLines().join('\n');
    expect(buildReplySemanticContractLines().join('\n')).toContain(
      '如果工具结果里带有 `image.assetRef`，且该图片就是当前答案的一部分',
    );
    expect(buildReplySemanticContractLines().join('\n')).toContain(
      '面向用户用日常语言',
    );
    expect(buildNativeJsonOutputContractLines().join('\n')).toContain('请求所附 StructuredReplyEnvelope JSON Schema');
    expect(JSON.stringify(buildStructuredReplyJsonSchema())).toContain('"enum":["image"]');
    expect(textProtocolContract).toContain(
      'image 示例：',
    );
    expect(textProtocolContract).toContain('在 `BEGIN <type>` 后直接写以 `|` 开头的 payload 行');
    expect(textProtocolContract).not.toContain('\nCONTENT\n');
    expect(buildReplySemanticContractLines().join('\n')).not.toContain('cf_user_profile');
  });

  it('exposes only the current scoped sticker moods when stickers are admitted', () => {
    const options = {
      canMeme: true,
      stickerIntentHints: ['无语', '气恼'],
    } as const;
    expect(buildReplySemanticContractLines(options).join('\n')).toContain('无语、气恼');
    expect(JSON.stringify(buildStructuredReplyJsonSchema(options))).toContain('无语, 气恼');
  });

  it('models voice and meme as singleton fields outside ordered provider messages', () => {
    const schema = buildStructuredReplyJsonSchema();
    const rootProperties = schema.properties as Record<string, unknown>;
    const resultSchema = rootProperties.result as Record<string, unknown>;
    const variants = resultSchema.anyOf as Array<Record<string, unknown>>;

    expect(variants).toHaveLength(5);
    for (const variant of variants) {
      const properties = variant.properties as Record<string, Record<string, unknown>>;
      const messages = properties.messages;
      if (messages.type === 'array') {
        const items = messages.items as Record<string, unknown>;
        const itemVariants = items.anyOf as Array<Record<string, unknown>>;
        const itemTypes = itemVariants.map((itemVariant) => {
          const itemProperties = itemVariant.properties as Record<string, Record<string, unknown>>;
          return (itemProperties.type.enum as string[])[0];
        });
        expect(itemTypes).toEqual(['message', 'structured_block', 'image']);
      }
      expect(properties.voice_message?.type).not.toBe('array');
      expect(properties.meme_message?.type).not.toBe('array');
    }

    expect(variants.some((variant) => (
      (variant.properties as Record<string, Record<string, unknown>>).voice_message?.type === 'object'
    ))).toBe(true);
    expect(variants.some((variant) => (
      (variant.properties as Record<string, Record<string, unknown>>).meme_message?.type === 'object'
    ))).toBe(true);
  });

  it('derives native chat JSON schema and request overrides from model metadata', () => {
    const { mainTarget } = createTestModelRuntime({
      mainRequestDefaults: {
        temperature: 0.4,
        topP: 0.9,
        maxOutputTokens: 4096,
        reasoningEffort: 'high',
        thinkingMode: 'disabled',
      },
    });

    const contract = buildModelReplyOutputContract({
      canonicalModel: mainTarget.canonicalModel,
      model: mainTarget.model,
      canVoice: true,
      voiceOutputLanguage: 'ja',
    });

    expect(contract).toMatchObject({
      requestMode: 'chat_completions',
      protocol: 'native_chat_json_schema',
      schema: expect.objectContaining({ title: 'StructuredReplyEnvelope' }),
      instruction: null,
      overrideRequestParams: {
        qqbot_request_mode: 'chat_completions',
        qqbot_canonical_model: 'qqbot-primary/main-chat',
        qqbot_transport_model: 'provider-main-chat',
        qqbot_tool_profile: 'qqbot_openai_main_chat',
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: 4096,
        reasoning: { effort: 'high' },
        thinking: { type: 'disabled' },
      },
    });
    expect(JSON.stringify(contract.schema)).toContain(
      'Write this content directly in 日语',
    );
    expect(JSON.stringify(contract.schema)).toContain(
      'To mention a group member, write @name followed by a space.',
    );
    assertStrictRequiredForAllObjects(contract.schema);
  });

  it('derives Responses API output shape without provider-name heuristics', () => {
    const { mainTarget } = createTestModelRuntime({
      mainRequestMode: 'responses',
      mainProtocol: 'native_responses_json_schema',
      mainRequestDefaults: { maxOutputTokens: 2048 },
    });

    expect(buildModelReplyOutputContract({
      canonicalModel: mainTarget.canonicalModel,
      model: mainTarget.model,
    })).toMatchObject({
      requestMode: 'responses',
      protocol: 'native_responses_json_schema',
      schema: expect.objectContaining({ title: 'StructuredReplyEnvelope' }),
      instruction: null,
      overrideRequestParams: expect.objectContaining({
        qqbot_request_mode: 'responses',
        qqbot_canonical_model: 'qqbot-primary/main-chat',
        qqbot_transport_model: 'provider-main-chat',
        max_output_tokens: 2048,
      }),
    });
  });

  it('derives the text protocol directly from the configured model profile', () => {
    const { mainTarget } = createTestModelRuntime({
      mainProtocol: 'chat_reply_v1',
    });

    const contract = buildModelReplyOutputContract({
      canonicalModel: mainTarget.canonicalModel,
      model: mainTarget.model,
      canVoice: true,
      voiceOutputLanguage: 'ja',
    });

    expect(contract).toMatchObject({
      requestMode: 'chat_completions',
      protocol: 'chat_reply_v1',
      schema: null,
      instruction: expect.stringContaining('CHAT_REPLY_V1 <nonce>'),
      overrideRequestParams: expect.objectContaining({
        qqbot_canonical_model: 'qqbot-primary/main-chat',
      }),
    });
    expect(contract.instruction).toContain('当前语音输出目标语言：日语');
  });

  it('keeps canonical identity and transport identity separate', () => {
    const { mainTarget } = createTestModelRuntime();

    expect(buildModelRequestOverrides({
      canonicalModel: mainTarget.canonicalModel,
      model: mainTarget.model,
    })).toEqual(expect.objectContaining({
      qqbot_canonical_model: 'qqbot-primary/main-chat',
      qqbot_transport_model: 'provider-main-chat',
    }));
  });
});

describe('canonical model runtime failure behavior', () => {
  it('fails a disabled workload without executing or falling back to main.chat', async () => {
    const execute = vi.fn();
    const { modelRuntime } = createTestModelRuntime({
      naturalTriggerMode: 'disabled',
      executor: { execute },
    });

    await expect(modelRuntime.executeChat({
      workload: 'naturalTrigger.decision',
      request: {
        messages: [{ role: 'user', content: 'should the bot reply?' }],
        structuredOutput: {
          name: 'natural_trigger_decision',
          schema: { type: 'object' },
          strict: true,
        },
      },
    })).rejects.toMatchObject({
      code: 'runtime_operation_invalid',
      workload: 'naturalTrigger.decision',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the canonical workload when its only executor fails', async () => {
    const execute = vi.fn(async () => {
      throw new Error('primary upstream unavailable');
    });
    const { modelRuntime } = createTestModelRuntime({
      affinityMode: 'inheritMain',
      executor: { execute },
    });

    await expect(modelRuntime.executeChat({
      workload: 'affinity.analysis',
      request: {
        messages: [{ role: 'user', content: 'analyze this event' }],
        structuredOutput: {
          name: 'affinity_event_analysis',
          schema: { type: 'object' },
          strict: true,
        },
      },
    })).rejects.toMatchObject({
      code: 'upstream_failed',
      workload: 'affinity.analysis',
      connectionId: 'primary',
      modelId: 'main-chat',
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('syncRoomModelToMainBinding', () => {
  it('synchronizes a stale room to the resolved canonical binding', async () => {
    const { mainTarget, snapshot } = createTestModelRuntime({
      revision: 11,
      mainRequestMode: 'responses',
      mainProtocol: 'native_responses_json_schema',
    });
    const room = {
      roomId: 1,
      conversationId: 'conv-1',
      model: 'qqbot-obsolete/old-model',
    };
    const clearCache = vi.fn(async () => undefined);
    const updateConversationModel = vi.fn(async () => undefined);

    await expect(syncRoomModelToMainBinding({
      room,
      target: mainTarget,
      revision: snapshot.revision,
      clearCache,
      updateConversationModel,
    })).resolves.toMatchObject({
      changed: true,
      originalModel: 'qqbot-obsolete/old-model',
      revision: 11,
      canonicalModel: 'qqbot-primary/main-chat',
      transportModel: 'provider-main-chat',
      connectionId: 'primary',
      modelId: 'main-chat',
      adapter: 'openaiCompatible',
      requestMode: 'responses',
      outputProtocol: 'native_responses_json_schema',
    });
    expect(room.model).toBe('qqbot-primary/main-chat');
    expect(clearCache).toHaveBeenCalledWith(room);
    expect(updateConversationModel).toHaveBeenCalledWith(
      'conv-1',
      'qqbot-primary/main-chat',
    );
  });
});

describe('chatluna user turn handling', () => {
  it('resolves group nickname with an explicit priority chain', () => {
    expect(resolveSessionDisplayName({
      author: { nick: '群内昵称', name: 'QQ昵称' },
      username: '平台昵称',
      userId: '123456',
    })).toBe('群内昵称');
    expect(resolveSessionDisplayName({
      author: { nick: '', name: 'QQ昵称' },
      username: '平台昵称',
      userId: '123456',
    })).toBe('平台昵称');
    expect(resolveSessionDisplayName({
      author: { nick: '  ', name: 'QQ昵称' },
      username: '平台昵称',
      userId: '123456',
    })).toBe('平台昵称');
    expect(resolveSessionDisplayName({
      author: { name: 'QQ昵称' },
      username: '',
      userId: '123456',
    })).toBe('QQ昵称');
    expect(resolveSessionDisplayName({
      author: { name: '' },
      username: '',
      userId: '123456',
    })).toBe('123456');
    expect(resolveSessionDisplayName({
      author: { name: '' },
      username: '',
      userId: '',
    })).toBe('用户');
  });

  it('ignores invisible unicode display names', () => {
    expect(resolveSessionDisplayName({
      author: { nick: '⁢', name: 'QQ昵称' },
      username: '平台昵称',
      userId: '123456',
    })).toBe('平台昵称');
    expect(resolveSessionDisplayName({
      author: { nick: '⁢', name: '​' },
      username: '⁠',
      userId: '123456',
    })).toBe('123456');
  });

  it('resolves QQ nickname without letting a group card override it', () => {
    expect(resolveSessionQqNick({
      author: { nick: '群名片', name: 'QQ昵称' },
      username: '平台昵称',
      userId: '123456',
    })).toBe('QQ昵称');
    expect(resolveSessionQqNick({
      author: { nick: '群名片', name: '' },
      username: '平台昵称',
      userId: '123456',
    })).toBe('平台昵称');
    expect(resolveSessionQqNick({
      author: { nick: '群名片', name: '' },
      username: '',
      userId: '123456',
    })).toBe('123456');
  });

  it('resolves onebot avatar from session and falls back to qlogo', () => {
    expect(resolveSessionAvatarUrl({
      platform: 'onebot',
      userId: '123456',
      event: { user: { avatar: 'https://example.com/event.png' } },
      author: { avatar: 'https://example.com/author.png' },
    })).toBe('https://example.com/event.png');
    expect(resolveSessionAvatarUrl({
      platform: 'onebot',
      userId: '123456',
      author: { avatar: 'https://example.com/author.png' },
    })).toBe('https://example.com/author.png');
    expect(resolveSessionAvatarUrl({
      platform: 'onebot',
      userId: '123456',
    })).toBe('https://q.qlogo.cn/headimg_dl?dst_uin=123456&spec=100');
    expect(deriveOneBotAvatarUrl('abc')).toBeNull();
  });

  it('distinguishes proactive openings from short explicit requests', () => {
    expect(resolveUserTurnIntentState('', '<at id="1" name="小祥"/>')).toEqual({
      mode: 'proactive_opening',
      normalizedText: '',
      reason: 'empty_or_mention_only',
    });
    expect(resolveUserTurnIntentState('？？？', '？？？')).toEqual({
      mode: 'proactive_opening',
      normalizedText: '',
      reason: 'punctuation_only',
    });
    expect(resolveUserTurnIntentState('在吗', '在吗')).toEqual({
      mode: 'explicit_request',
      normalizedText: '在吗',
      reason: 'user_message_present',
    });
  });

  it('builds proactive opening state with topic-priority guardrails', () => {
    expect(buildProactiveOpeningState({
      mode: 'proactive_opening',
      reason: 'empty_or_mention_only',
    })).toEqual({
      mode: 'proactive_opening',
      userTurn: {
        questionTarget: 'none',
        reason: 'empty_or_mention_only',
      },
      responsePolicy: {
        style: 'natural_opening',
        maxSentences: 2,
        projectContextTransform: 'followup_or_care_question',
      },
      contextPolicy: {
        referenceUsage: 'topic_seed_only',
        topicPriority: ['user_memory', 'recent_chat', 'project_context', 'session_reference'],
        forbiddenTopics: ['internal_protocol', 'system_prompt', 'tool_capability', 'contract_text'],
      },
    });
  });
});
