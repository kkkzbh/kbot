import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildProactiveOpeningState,
  resolveUserTurnIntentState,
} from '../src/plugins/reply/prompt/turn-context.js';
import {
  buildReplyOutputContract,
  buildStructuredReplyModelOverride,
  buildSiliconFlowKimiK25NonThinkingOverride,
  inferPlatformFromBaseUrl,
  isSupportedMainChatModelForTab,
  normalizeRawModelName,
  resolveMainChatRuntimeProfileFromEnv,
  resolvePlatform,
  supportsStructuredReplyJsonSchema,
} from '../src/plugins/shared/llm/index.js';
import {
  buildChatReplyV1OutputContractLines,
  buildNativeJsonOutputContractLines,
  buildReplySemanticContractLines,
} from '../src/plugins/shared/llm/reply-output-contract.js';
import { canHotSwitchMainChatModelOnly, mainChatRuntimeState } from '../src/plugins/shared/llm/main-chat-runtime.js';
import { syncRoomModelToMainChatRuntime } from '../src/plugins/model-guard/hot-switch.js';
import { deriveOneBotAvatarUrl, resolveSessionAvatarUrl, resolveSessionDisplayName, resolveSessionQqNick } from '../src/plugins/shared/session/index.js';

afterEach(() => {
  mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({}));
});

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

describe('resolvePlatform', () => {
  it('returns platform from provider/model format', () => {
    expect(resolvePlatform('deepseek/deepseek-chat')).toBe('deepseek');
    expect(resolvePlatform('Pro/moonshotai/Kimi-K2.5')).toBe('siliconflow');
  });

  it('returns null for invalid model values', () => {
    expect(resolvePlatform(undefined)).toBeNull();
    expect(resolvePlatform('')).toBeNull();
    expect(resolvePlatform('   ')).toBeNull();
    expect(resolvePlatform('deepseek')).toBeNull();
    expect(resolvePlatform('/deepseek-chat')).toBeNull();
  });
});

describe('normalizeRawModelName', () => {
  it('keeps provider/model unchanged', () => {
    expect(normalizeRawModelName('deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat');
  });

  it('normalizes vendor/model names through the preferred platform', () => {
    expect(
      normalizeRawModelName('Pro/moonshotai/Kimi-K2.5', {
        availableModels: ['siliconflow/Pro/moonshotai/Kimi-K2.5'],
        preferredPlatform: 'siliconflow',
      }),
    ).toBe('Pro/moonshotai/Kimi-K2.5');
  });

  it('resolves plain model by available model suffix', () => {
    expect(
      normalizeRawModelName('deepseek-chat', {
        availableModels: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini'],
      }),
    ).toBe('deepseek/deepseek-chat');
  });

  it('resolves plain MIMO chat models by available model suffix', () => {
    expect(
      normalizeRawModelName('mimo-v2.5-pro', {
        availableModels: ['mimo/mimo-v2.5-pro'],
        preferredPlatform: 'mimo',
      }),
    ).toBe('mimo/mimo-v2.5-pro');
  });

  it('falls back to preferred platform when suffix is ambiguous', () => {
    expect(
      normalizeRawModelName('chat', {
        availableModels: ['deepseek/chat', 'openai/chat'],
        preferredPlatform: 'openai',
      }),
    ).toBe('openai/chat');
  });

  it('fills missing model with default model', () => {
    expect(
      normalizeRawModelName('', {
        defaultModel: 'deepseek/deepseek-chat',
      }),
    ).toBe('deepseek/deepseek-chat');
  });

  it('treats the chatluna none sentinel as missing model', () => {
    expect(
      normalizeRawModelName('无', {
        defaultModel: 'Pro/moonshotai/Kimi-K2.5',
      }),
    ).toBe('Pro/moonshotai/Kimi-K2.5');
  });
});

describe('buildSiliconFlowKimiK25NonThinkingOverride', () => {
  it('returns a non-thinking override for SiliconFlow Kimi K2.5', () => {
    expect(buildSiliconFlowKimiK25NonThinkingOverride('Pro/moonshotai/Kimi-K2.5')).toEqual({
      thinking: {
        type: 'disabled',
      },
    });
    expect(buildSiliconFlowKimiK25NonThinkingOverride('siliconflow/Pro/moonshotai/Kimi-K2.5')).toEqual({
      thinking: {
        type: 'disabled',
      },
    });
  });

  it('returns null for non-Kimi-K2.5 models', () => {
    expect(buildSiliconFlowKimiK25NonThinkingOverride('deepseek/deepseek-chat')).toBeNull();
    expect(buildSiliconFlowKimiK25NonThinkingOverride('siliconflow/Pro/moonshotai/Kimi-K2-Instruct-0905')).toBeNull();
  });
});

describe('buildStructuredReplyModelOverride', () => {
  it('keeps the Kimi non-thinking override and keeps OpenAI on chat completions mode', () => {
    expect(buildStructuredReplyModelOverride('Pro/moonshotai/Kimi-K2.5')).toEqual({
      thinking: {
        type: 'disabled',
      },
    });
    expect(buildStructuredReplyModelOverride('openai/gpt-5.4-medium-thinking')).toEqual({
      qqbot_canonical_model: 'openai/gpt-5.4-medium-thinking',
      qqbot_transport_model: 'gpt-5.4-medium-thinking',
      qqbot_tool_profile: 'qqbot_openai_main_chat',
      reasoning: {
        effort: 'medium',
      },
    });
    expect(buildStructuredReplyModelOverride('openai/gpt-4o')).toEqual({
      qqbot_canonical_model: 'openai/gpt-4o',
      qqbot_transport_model: 'gpt-4o',
      qqbot_tool_profile: 'qqbot_openai_main_chat',
    });
  });
});

describe('supportsStructuredReplyJsonSchema', () => {
  it('supports both the Kimi and OpenAI gpt-5.4 main-chat families', () => {
    expect(supportsStructuredReplyJsonSchema('Pro/moonshotai/Kimi-K2.5')).toBe(true);
    expect(supportsStructuredReplyJsonSchema('siliconflow/Pro/moonshotai/Kimi-K2.5')).toBe(true);
    expect(supportsStructuredReplyJsonSchema('openai/gpt-5.4')).toBe(true);
    expect(supportsStructuredReplyJsonSchema('openai/gpt-5.4-medium-thinking')).toBe(true);
    expect(supportsStructuredReplyJsonSchema('openai/gpt-5.5')).toBe(true);
    expect(supportsStructuredReplyJsonSchema('openai/gpt-4o')).toBe(true);
    expect(supportsStructuredReplyJsonSchema('openai/gpt-5-mini')).toBe(true);
    expect(supportsStructuredReplyJsonSchema('openai/gemini-3.1-pro-preview')).toBe(false);
  });
});

describe('buildReplyOutputContract', () => {
  it('documents generic image final replies without disabled tool-specific guidance', () => {
    expect(buildReplySemanticContractLines().join('\n')).toContain(
      '如果工具结果里带有 `image.assetRef`，且该图片就是当前答案的一部分',
    );
    expect(buildNativeJsonOutputContractLines().join('\n')).toContain(
      '"type": "image"',
    );
    expect(buildChatReplyV1OutputContractLines().join('\n')).toContain(
      'image 示例：',
    );
    expect(buildReplySemanticContractLines().join('\n')).not.toContain('cf_user_profile');
  });

  it('injects the configured voice output language into json schema and text protocol contracts', () => {
    const schemaContract = buildReplyOutputContract({
      model: 'openai/gpt-5.4-medium-thinking',
      canVoice: true,
      voiceOutputLanguage: 'ja',
    });
    expect(JSON.stringify(schemaContract.schema)).toContain('Write this content directly in 日语');

    const textContract = buildReplyOutputContract({
      model: 'deepseek/deepseek-v4-flash',
      canVoice: true,
      voiceOutputLanguage: 'ja',
    });
    expect(textContract.instruction).toContain('当前语音输出目标语言：日语');
    expect(textContract.instruction).toContain('|本当にうれしいです。');
  });

  it('routes schema-capable providers to json_schema and text-only Copilot models to CHAT_REPLY_V1', () => {
    expect(
      buildReplyOutputContract({
        model: 'Pro/moonshotai/Kimi-K2.5',
      }),
    ).toMatchObject({
      requestMode: 'chat_completions',
      protocol: 'native_chat_json_schema',
      schema: expect.objectContaining({
        title: 'StructuredReply',
      }),
      instruction: null,
      overrideRequestParams: {
        thinking: {
          type: 'disabled',
        },
      },
    });

    expect(
      buildReplyOutputContract({
        model: 'openai/gpt-5.4-medium-thinking',
      }),
    ).toMatchObject({
      requestMode: 'chat_completions',
      protocol: 'native_chat_json_schema',
      schema: expect.objectContaining({
        title: 'StructuredReply',
      }),
      instruction: null,
      overrideRequestParams: {
        qqbot_canonical_model: 'openai/gpt-5.4-medium-thinking',
        qqbot_transport_model: 'gpt-5.4-medium-thinking',
        reasoning: {
          effort: 'medium',
        },
      },
    });

    expect(
      buildReplyOutputContract({
        model: 'gpt-4o',
      }),
    ).toMatchObject({
      requestMode: 'chat_completions',
      protocol: 'native_chat_json_schema',
      schema: expect.objectContaining({
        title: 'StructuredReply',
      }),
      instruction: null,
      overrideRequestParams: {
        qqbot_canonical_model: 'openai/gpt-4o',
        qqbot_transport_model: 'gpt-4o',
      },
    });

    expect(
      buildReplyOutputContract({
        model: 'openai/gemini-3.1-pro-preview',
      }),
    ).toMatchObject({
      requestMode: 'chat_completions',
      protocol: 'chat_reply_v1',
      schema: null,
      instruction: expect.stringContaining('CHAT_REPLY_V1 <nonce>'),
      overrideRequestParams: {
        qqbot_canonical_model: 'openai/gemini-3.1-pro-preview',
        qqbot_transport_model: 'gemini-3.1-pro-preview',
      },
    });
  });

  it('routes DeepSeek chat completions through the plain text reply protocol', () => {
    expect(
      buildReplyOutputContract({
        model: 'deepseek/deepseek-v4-flash',
      }),
    ).toMatchObject({
      requestMode: 'chat_completions',
      protocol: 'chat_reply_v1',
      schema: null,
      instruction: expect.stringContaining('CHAT_REPLY_V1 <nonce>'),
      overrideRequestParams: {
        qqbot_canonical_model: 'deepseek/deepseek-v4-flash',
        qqbot_transport_model: 'deepseek-v4-flash',
        qqbot_tool_profile: 'qqbot_openai_main_chat',
      },
    });
  });

  it('keeps Copilot gpt-5.4 family on responses mode', () => {
    expect(
      buildReplyOutputContract({
        model: 'openai/gpt-5.4-mini',
      }),
    ).toMatchObject({
      requestMode: 'responses',
      protocol: 'native_responses_json_schema',
      schema: expect.objectContaining({
        title: 'StructuredReply',
      }),
      instruction: null,
      overrideRequestParams: {
        qqbot_request_mode: 'responses',
        qqbot_canonical_model: 'openai/gpt-5.4-mini',
        qqbot_transport_model: 'gpt-5.4-mini',
      },
    });
  });

  it('routes Codex OAuth models to Responses API native structured outputs', () => {
    expect(
      buildReplyOutputContract({
        model: 'openai/gpt-5.5',
      }),
    ).toMatchObject({
      requestMode: 'responses',
      protocol: 'native_responses_json_schema',
      schema: expect.objectContaining({
        title: 'StructuredReply',
      }),
      instruction: null,
      overrideRequestParams: {
        qqbot_request_mode: 'responses',
        qqbot_canonical_model: 'openai/gpt-5.5',
        qqbot_transport_model: 'gpt-5.5',
        qqbot_tool_profile: 'qqbot_openai_main_chat',
        reasoning: {
          effort: 'medium',
        },
      },
    });
  });

  it('keeps mentions inline in message content schema', () => {
    const schema = buildReplyOutputContract({
      model: 'openai/gpt-5.4-medium-thinking',
      canMention: true,
    }).schema as {
      properties?: {
        outbound_messages?: {
          anyOf?: Array<{
            items?: {
              anyOf?: Array<{
                title?: string;
                description?: string;
                anyOf?: Array<{ title?: string; description?: string; properties?: Record<string, { description?: string }> }>;
                properties?: Record<string, { description?: string }>;
              }>;
            };
          }>;
        };
      };
    };

    const rawMessageSchemas = schema.properties?.outbound_messages?.anyOf?.find((item) => item.items?.anyOf)?.items?.anyOf ?? [];
    const messageSchemas = rawMessageSchemas.flatMap((item) => item.anyOf ?? [item]);
    const textMessage = messageSchemas.find((item) => item.title === 'MessageItem') as
      | {
          description?: string;
          required?: string[];
          properties?: Record<string, { description?: string }>;
        }
      | undefined;

    expect(textMessage?.description).toBe('Ordinary chat message.');
    expect(textMessage?.properties?.type?.description).toBe('Ordinary chat message.');
    expect(textMessage?.properties?.content?.description).toBe(
      'Ordinary conversational plain text for this chat message. To mention a group member, write @name followed by a space directly in this text.',
    );
    expect(textMessage?.properties?.mentions).toBeUndefined();
    expect(textMessage?.required).toEqual(['type', 'content']);
    assertStrictRequiredForAllObjects(schema);

    const structuredBlock = messageSchemas.find((item) => item.title === 'StructuredBlockItem') as
      | {
          description?: string;
          properties?: Record<string, { description?: string }>;
        }
      | undefined;
    expect(structuredBlock?.description).toBe('Structured text that should stay intact in one message.');
    expect(structuredBlock?.properties?.type?.description).toBe('Structured text that should stay intact in one message.');
    expect(structuredBlock?.properties?.content?.description).toBe('Structured text to keep intact, such as code, lists, or quotes.');

    const privateSchema = buildReplyOutputContract({
      model: 'openai/gpt-5.4-medium-thinking',
      canMention: false,
    }).schema as {
      properties?: {
        outbound_messages?: {
          anyOf?: Array<{
            items?: {
              anyOf?: Array<{
                title?: string;
                description?: string;
                anyOf?: Array<{ title?: string }>;
              }>;
            };
          }>;
        };
      };
    };

    const privateRawSchemas = privateSchema.properties?.outbound_messages?.anyOf?.find((item) => item.items?.anyOf)?.items?.anyOf ?? [];
    const privateMessageSchemas = privateRawSchemas.flatMap((item) => item.anyOf ?? [item]);
    const privateTextMessage = privateMessageSchemas.find((item) => item.title === 'MessageItem') as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(privateTextMessage?.properties?.mentions).toBeUndefined();
    assertStrictRequiredForAllObjects(privateSchema);
  });
});

describe('isSupportedMainChatModelForTab', () => {
  it('enforces the fixed model whitelist for built-in tabs', () => {
    expect(isSupportedMainChatModelForTab('siliconflow', 'Pro/moonshotai/Kimi-K2.5')).toBe(true);
    expect(isSupportedMainChatModelForTab('siliconflow', 'siliconflow/Pro/moonshotai/Kimi-K2.5')).toBe(true);
    expect(isSupportedMainChatModelForTab('siliconflow', 'openai/gpt-5.4-medium-thinking')).toBe(false);
    expect(isSupportedMainChatModelForTab('openai', 'openai/gpt-5.4-medium-thinking')).toBe(true);
    expect(isSupportedMainChatModelForTab('openai', 'openai/gpt-5.2')).toBe(false);
    expect(isSupportedMainChatModelForTab('codex', 'openai/gpt-5.5')).toBe(true);
    expect(isSupportedMainChatModelForTab('codex', 'gpt-5.4-mini')).toBe(true);
    expect(isSupportedMainChatModelForTab('codex', 'bad model')).toBe(false);
    expect(isSupportedMainChatModelForTab('copilot', 'openai/gpt-5.4')).toBe(false);
    expect(isSupportedMainChatModelForTab('copilot', 'openai/gpt-5.4-mini')).toBe(true);
    expect(isSupportedMainChatModelForTab('copilot', 'gpt-5-mini')).toBe(true);
    expect(isSupportedMainChatModelForTab('copilot', 'gpt-4.1')).toBe(true);
    expect(isSupportedMainChatModelForTab('copilot', 'gpt-4o')).toBe(true);
    expect(isSupportedMainChatModelForTab('copilot', 'openai/gpt-4o')).toBe(true);
    expect(isSupportedMainChatModelForTab('copilot', 'github-copilot/claude-haiku-4.5')).toBe(true);
    expect(isSupportedMainChatModelForTab('copilot', 'openai/gemini-3.1-pro-preview')).toBe(true);
    expect(isSupportedMainChatModelForTab('copilot', 'gemini-3-flash-preview')).toBe(true);
    expect(isSupportedMainChatModelForTab('copilot', 'bad model')).toBe(false);
    expect(isSupportedMainChatModelForTab('deepseek', 'deepseek-v4-flash')).toBe(true);
    expect(isSupportedMainChatModelForTab('deepseek', 'deepseek/deepseek-v4-pro')).toBe(true);
    expect(isSupportedMainChatModelForTab('deepseek', 'not-official')).toBe(false);
    expect(isSupportedMainChatModelForTab('deepseek', 'openai/deepseek-v4-pro')).toBe(false);
    expect(isSupportedMainChatModelForTab('mimo', 'mimo-v2.5-pro')).toBe(true);
    expect(isSupportedMainChatModelForTab('mimo', 'mimo/mimo-v2.5-pro')).toBe(true);
    expect(isSupportedMainChatModelForTab('mimo', 'mimo-v2.5-tts')).toBe(false);
  });
});

describe('canHotSwitchMainChatModelOnly', () => {
  it('requires a restart for Copilot OAuth model registry changes', () => {
    const current = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'bridge-secret',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gpt-5.4-mini',
    });
    const next = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'bridge-secret',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gpt-5-mini',
    });

    expect(canHotSwitchMainChatModelOnly(current, next)).toBe(false);
  });

  it('allows hot switching static OpenAI model variants on the same endpoint', () => {
    const current = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_OPENAI_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_OPENAI_API_KEY: 'sk-openai',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
    });
    const next = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_OPENAI_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_OPENAI_API_KEY: 'sk-openai',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-high-thinking',
    });

    expect(canHotSwitchMainChatModelOnly(current, next)).toBe(true);
  });
});

describe('inferPlatformFromBaseUrl', () => {
  it('infers platform from base url', () => {
    expect(inferPlatformFromBaseUrl('https://api.siliconflow.cn/v1')).toBe('siliconflow');
    expect(inferPlatformFromBaseUrl('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(inferPlatformFromBaseUrl('https://api.openai.com/v1')).toBe('openai');
    expect(inferPlatformFromBaseUrl('https://api.anthropic.com')).toBe('anthropic');
    expect(inferPlatformFromBaseUrl('https://shell.wyzai.top/v1')).toBe('openai');
    expect(inferPlatformFromBaseUrl('https://token-plan-cn.xiaomimimo.com/v1')).toBe('mimo');
  });
});

describe('resolveMainChatRuntimeProfileFromEnv', () => {
  it('resolves active built-in tab into a runtime profile with strategy metadata', () => {
    expect(
      resolveMainChatRuntimeProfileFromEnv({
        CHATLUNA_ACTIVE_TAB: 'openai',
        CHATLUNA_OPENAI_BASE_URL: 'https://shell.wyzai.top/v1',
        CHATLUNA_OPENAI_API_KEY: 'sk-openai',
        CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
      }),
    ).toMatchObject({
      tabId: 'openai',
      provider: 'openai',
      strategyId: 'openai-gpt54-main-chat',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'native_chat_json_schema',
      baseUrl: 'https://shell.wyzai.top/v1',
      defaultModel: 'openai/gpt-5.4-medium-thinking',
    });
  });

  it('normalizes legacy siliconflow model ids and locks the siliconflow base url', () => {
    expect(
      resolveMainChatRuntimeProfileFromEnv({
        CHATLUNA_ACTIVE_TAB: 'siliconflow',
        CHATLUNA_BASE_URL: 'https://custom.invalid/v1',
        CHATLUNA_API_KEY: 'sk-siliconflow',
        CHATLUNA_DEFAULT_MODEL: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
        CHATLUNA_SILICONFLOW_BASE_URL: 'https://custom.invalid/v1',
        CHATLUNA_SILICONFLOW_API_KEY: 'sk-siliconflow',
        CHATLUNA_SILICONFLOW_DEFAULT_MODEL: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
      }),
    ).toMatchObject({
      tabId: 'siliconflow',
      provider: 'siliconflow',
      requestMode: 'chat_completions',
      baseUrl: 'https://api.siliconflow.cn/v1',
      defaultModel: 'Pro/moonshotai/Kimi-K2.5',
      canonicalModel: 'Pro/moonshotai/Kimi-K2.5',
      transportModel: 'Pro/moonshotai/Kimi-K2.5',
    });
  });

  it('resolves the copilot tab into a Copilot OAuth runtime profile', () => {
    expect(
      resolveMainChatRuntimeProfileFromEnv({
        CHATLUNA_ACTIVE_TAB: 'copilot',
        CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
        CHATLUNA_COPILOT_API_KEY: 'bridge-secret',
        CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gpt-5.4-mini',
      }),
    ).toMatchObject({
      tabId: 'copilot',
      provider: 'openai',
      strategyId: 'copilot-github-oauth-main-chat',
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
      baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      defaultModel: 'openai/gpt-5.4-mini',
      canonicalModel: 'openai/gpt-5.4-mini',
      transportModel: 'gpt-5.4-mini',
    });
  });

  it('resolves the Codex tab into a ChatGPT OAuth Responses runtime profile', () => {
    expect(
      resolveMainChatRuntimeProfileFromEnv({
        CHATLUNA_ACTIVE_TAB: 'codex',
        CHATLUNA_CODEX_BASE_URL: 'http://127.0.0.1:5140/api/internal/codex/v1',
        CHATLUNA_CODEX_API_KEY: 'codex-bridge-secret',
        CHATLUNA_CODEX_DEFAULT_MODEL: 'openai/gpt-5.5',
        CHATLUNA_CODEX_REASONING_EFFORT: 'high',
      }),
    ).toMatchObject({
      tabId: 'codex',
      provider: 'openai',
      strategyId: 'codex-chatgpt-oauth-main-chat',
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
      authKind: 'codex_oauth',
      baseUrl: 'http://127.0.0.1:5140/api/internal/codex/v1',
      defaultModel: 'openai/gpt-5.5',
      reasoningEffort: 'high',
      canonicalModel: 'openai/gpt-5.5',
      transportModel: 'gpt-5.5',
    });
  });

  it('switches the Copilot runtime profile to chat completions for non-responses models', () => {
    expect(
      resolveMainChatRuntimeProfileFromEnv({
        CHATLUNA_ACTIVE_TAB: 'copilot',
        CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
        CHATLUNA_COPILOT_API_KEY: 'bridge-secret',
        CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gemini-3.1-pro-preview',
      }),
    ).toMatchObject({
      tabId: 'copilot',
      provider: 'openai',
      strategyId: 'copilot-github-oauth-main-chat',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
      defaultModel: 'openai/gemini-3.1-pro-preview',
      canonicalModel: 'openai/gemini-3.1-pro-preview',
      transportModel: 'gemini-3.1-pro-preview',
    });
  });

  it('resolves the DeepSeek tab into an official chat completions runtime profile', () => {
    expect(
      resolveMainChatRuntimeProfileFromEnv({
        CHATLUNA_ACTIVE_TAB: 'deepseek',
        CHATLUNA_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        CHATLUNA_DEEPSEEK_API_KEY: 'sk-deepseek',
        CHATLUNA_DEEPSEEK_DEFAULT_MODEL: 'deepseek-v4-pro',
      }),
    ).toMatchObject({
      tabId: 'deepseek',
      provider: 'deepseek',
      strategyId: 'deepseek-official-main-chat',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek/deepseek-v4-pro',
      canonicalModel: 'deepseek/deepseek-v4-pro',
      transportModel: 'deepseek-v4-pro',
    });
  });

  it('resolves the MIMO tab into a chat completions runtime profile', () => {
    expect(
      resolveMainChatRuntimeProfileFromEnv({
        CHATLUNA_ACTIVE_TAB: 'mimo',
        CHATLUNA_MIMO_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/v1',
        CHATLUNA_MIMO_API_KEY: 'sk-mimo',
        CHATLUNA_MIMO_DEFAULT_MODEL: 'mimo-v2.5-pro',
      }),
    ).toMatchObject({
      tabId: 'mimo',
      provider: 'mimo',
      strategyId: 'mimo-official-main-chat',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'native_chat_json_schema',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      defaultModel: 'mimo/mimo-v2.5-pro',
      canonicalModel: 'mimo/mimo-v2.5-pro',
      transportModel: 'mimo-v2.5-pro',
    });
    expect(isSupportedMainChatModelForTab('mimo', 'mimo/mimo-v2.5-pro')).toBe(true);
    expect(isSupportedMainChatModelForTab('mimo', 'mimo-v2.5-tts')).toBe(false);
  });
});

describe('syncRoomModelToMainChatRuntime', () => {
  it('lazily overwrites stale room models and clears the cached conversation', async () => {
    mainChatRuntimeState.initialize(resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'bridge-secret',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/gpt-5.4-mini',
    }));
    mainChatRuntimeState.hotSwitchModel(resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'bridge-secret',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'openai/claude-haiku-4.5',
    }));

    const room = {
      roomId: 1,
      conversationId: 'conv-1',
      model: 'openai/gpt-5.4-mini',
    };
    const clearCache = vi.fn(async () => undefined);
    const updateConversationModel = vi.fn(async () => undefined);

    await expect(syncRoomModelToMainChatRuntime({ room, clearCache, updateConversationModel })).resolves.toMatchObject({
      changed: true,
      originalModel: 'openai/gpt-5.4-mini',
      generation: 1,
      canonicalModel: 'openai/claude-haiku-4.5',
      transportModel: 'claude-haiku-4.5',
      strategyId: 'copilot-github-oauth-main-chat',
      requestMode: 'chat_completions',
      outputProtocol: 'chat_reply_v1',
    });
    expect(room.model).toBe('openai/claude-haiku-4.5');
    expect(clearCache).toHaveBeenCalledWith(room);
    expect(updateConversationModel).toHaveBeenCalledWith('conv-1', 'openai/claude-haiku-4.5');
  });
});

describe('chatluna user turn handling', () => {
  it('resolves group nickname with || fallback chain (handles empty string)', () => {
    // Group card (群名片) takes priority
    expect(
      resolveSessionDisplayName({
        author: { nick: '群内昵称', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('群内昵称');
    // Empty group card falls back to username
    expect(
      resolveSessionDisplayName({
        author: { nick: '', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('平台昵称');
    // Whitespace-only group card falls back to username
    expect(
      resolveSessionDisplayName({
        author: { nick: '  ', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('平台昵称');
    // Missing group card falls back through chain
    expect(
      resolveSessionDisplayName({
        author: { name: 'QQ昵称' },
        username: '',
        userId: '123456',
      }),
    ).toBe('QQ昵称');
    // All empty falls back to userId
    expect(
      resolveSessionDisplayName({
        author: { name: '' },
        username: '',
        userId: '123456',
      }),
    ).toBe('123456');
    // Everything missing falls back to '用户'
    expect(
      resolveSessionDisplayName({
        author: { name: '' },
        username: '',
        userId: '',
      }),
    ).toBe('用户');
  });

  it('falls back when group card is invisible unicode', () => {
    // U+2062 INVISIBLE TIMES should be treated as empty display name.
    expect(
      resolveSessionDisplayName({
        author: { nick: '⁢', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('平台昵称');
  });

  it('falls back when all higher-priority names are invisible unicode', () => {
    expect(
      resolveSessionDisplayName({
        author: { nick: '⁢', name: '​' },
        username: '⁠',
        userId: '123456',
      }),
    ).toBe('123456');
  });

  it('resolves QQ nickname without letting group card override it', () => {
    expect(
      resolveSessionQqNick({
        author: { nick: '群名片', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('QQ昵称');
    expect(
      resolveSessionQqNick({
        author: { nick: '群名片', name: '' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('平台昵称');
    expect(
      resolveSessionQqNick({
        author: { nick: '群名片', name: '' },
        username: '',
        userId: '123456',
      }),
    ).toBe('123456');
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
    expect(resolveSessionAvatarUrl({ platform: 'onebot', userId: '123456' })).toBe(
      'https://q.qlogo.cn/headimg_dl?dst_uin=123456&spec=100',
    );
    expect(deriveOneBotAvatarUrl('abc')).toBeNull();
  });

  it('treats mention-only or punctuation-only turns as proactive openings', () => {
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
  });

  it('keeps short but substantive turns as explicit requests', () => {
    expect(resolveUserTurnIntentState('在吗', '在吗')).toEqual({
      mode: 'explicit_request',
      normalizedText: '在吗',
      reason: 'user_message_present',
    });
    expect(resolveUserTurnIntentState('今天呢', '今天呢')).toEqual({
      mode: 'explicit_request',
      normalizedText: '今天呢',
      reason: 'user_message_present',
    });
  });

  it('builds proactive opening state with topic-priority guardrails', () => {
    expect(
      buildProactiveOpeningState({
        mode: 'proactive_opening',
        reason: 'empty_or_mention_only',
      }),
    ).toEqual({
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
