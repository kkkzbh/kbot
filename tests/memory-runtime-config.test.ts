import { describe, expect, it } from 'vitest';
import { buildMemoryExtractProviderProfile, isMemoryProviderConfigured } from '../src/plugins/memory/providers/router.js';
import { resolveMainChatRuntimeProfileFromEnv } from '../src/plugins/shared/llm/main-chat-tabs.js';

const configuredExtractDefaults = {
  baseUrl: '',
  apiKey: '',
  model: '',
  timeoutMs: 60_000,
  requestMode: 'chat_completions',
  structuredOutputProtocol: 'chat_reply_v1',
  supportsJsonMode: false,
} as const;

describe('memory runtime config', () => {
  it('keeps extraction unconfigured when extract provider fields are all empty', () => {
    const mainProfile = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'copilot-key',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'auto',
    });

    const profile = buildMemoryExtractProviderProfile(mainProfile, configuredExtractDefaults);

    expect(profile).toMatchObject({
      baseUrl: '',
      apiKey: '',
      model: '',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
    });
    expect(isMemoryProviderConfigured(profile)).toBe(false);
  });

  it('does not mix partial extract provider fields with the main chat provider', () => {
    const mainProfile = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'copilot-key',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'auto',
    });

    const profile = buildMemoryExtractProviderProfile(mainProfile, {
      ...configuredExtractDefaults,
      apiKey: 'extract-key',
    });

    expect(profile).toMatchObject({
      baseUrl: '',
      apiKey: 'extract-key',
      model: '',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
    });
    expect(isMemoryProviderConfigured(profile)).toBe(false);
  });

  it('uses only a complete dedicated extract provider', () => {
    const mainProfile = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'deepseek',
      CHATLUNA_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      CHATLUNA_DEEPSEEK_API_KEY: 'deepseek-key',
      CHATLUNA_DEEPSEEK_DEFAULT_MODEL: 'deepseek/deepseek-v4-flash',
    });

    const profile = buildMemoryExtractProviderProfile(mainProfile, {
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'extract-key',
      model: 'Pro/moonshotai/Kimi-K2.5',
      timeoutMs: 60_000,
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
      supportsJsonMode: false,
    });

    expect(profile).toMatchObject({
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'extract-key',
      model: 'Pro/moonshotai/Kimi-K2.5',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
    });
    expect(isMemoryProviderConfigured(profile)).toBe(true);
  });
});
