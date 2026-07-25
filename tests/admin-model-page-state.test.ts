import { describe, expect, it } from 'vitest';
import type {
  ModelOption,
  ModelTab,
  ModelTabsResponse,
} from '../src/admin/contracts/index.js';
import {
  buildModelTabsPatchRequest,
  loadModelPageConfiguration,
  modelOptionValue,
  omitProviderModelOptions,
  requireCacheableModelOptions,
  toModelDraft,
} from '../apps/admin-web/src/pages/model-page-state.js';

function modelTab(id: ModelTab['id'], overrides: Partial<ModelTab> = {}): ModelTab {
  const provider = id === 'siliconflow' ? 'siliconflow' : id === 'deepseek' ? 'deepseek' : id === 'mimo' ? 'mimo' : 'openai';
  const strategies: Record<ModelTab['id'], ModelTab['strategyId']> = {
    siliconflow: 'siliconflow-kimi-main-chat',
    openai: 'openai-gpt54-main-chat',
    codex: 'codex-chatgpt-oauth-main-chat',
    copilot: 'copilot-github-oauth-main-chat',
    deepseek: 'deepseek-official-main-chat',
    mimo: 'mimo-official-main-chat',
  };
  return {
    id,
    title: id,
    provider,
    strategyId: strategies[id],
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'native_chat_json_schema',
    description: `${id} provider`,
    modelHint: `${id}/default`,
    authKind: id === 'codex' ? 'codex_oauth' : id === 'copilot' ? 'oauth_device' : 'manual',
    authStatus: 'ready',
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: null,
    apiKeyConfigured: true,
    defaultModel: `${id}/default`,
    ...overrides,
  };
}

function modelTabs(): ModelTabsResponse {
  return {
    activeTab: 'openai',
    tabs: [
      modelTab('openai'),
      modelTab('deepseek'),
      modelTab('codex', { reasoningEffort: 'medium' }),
    ],
  };
}

describe('admin model page state', () => {
  it('loads required model configuration through its own state boundary', async () => {
    const configuration = modelTabs();
    const result = await loadModelPageConfiguration(Promise.resolve(configuration));

    expect(result).toEqual({
      modelState: configuration,
      requiredError: null,
    });
  });

  it('exposes a retryable required-load error instead of creating an empty page', async () => {
    const result = await loadModelPageConfiguration(Promise.reject(new Error('models unavailable')));

    expect(result).toEqual({
      modelState: null,
      requiredError: 'models unavailable',
    });
  });

  it('patches every dirty tab while preserving drafts created before a tab switch', () => {
    const saved = modelTabs();
    const drafts = Object.fromEntries(saved.tabs.map((tab) => [tab.id, toModelDraft(tab)]));
    drafts.openai!.baseUrl = 'https://openai-next.example.com/v1';
    drafts.deepseek!.defaultModel = 'deepseek/deepseek-v4-pro';
    drafts.deepseek!.apiKey = 'next-deepseek-key';

    const request = buildModelTabsPatchRequest(saved, drafts, 'deepseek');

    expect(request).toEqual({
      activeTab: 'deepseek',
      dirtyTabIds: ['openai', 'deepseek'],
      tabs: [
        {
          id: 'openai',
          baseUrl: 'https://openai-next.example.com/v1',
          defaultModel: 'openai/default',
        },
        {
          id: 'deepseek',
          baseUrl: 'https://deepseek.example.com/v1',
          apiKey: 'next-deepseek-key',
          defaultModel: 'deepseek/deepseek-v4-pro',
        },
      ],
    });
    expect(drafts.openai!.baseUrl).toBe('https://openai-next.example.com/v1');
  });

  it('creates a valid patch when only the active tab changes', () => {
    const saved = modelTabs();
    const drafts = Object.fromEntries(saved.tabs.map((tab) => [tab.id, toModelDraft(tab)]));

    expect(buildModelTabsPatchRequest(saved, drafts, 'codex')).toEqual({
      activeTab: 'codex',
      dirtyTabIds: ['codex'],
      tabs: [{
        id: 'codex',
        baseUrl: 'https://codex.example.com/v1',
        defaultModel: 'codex/default',
        reasoningEffort: 'medium',
      }],
    });
  });

  it('uses canonical model identity for selection and invalidates only the OAuth provider cache', () => {
    const option = {
      canonicalModel: 'openai/gpt-5.5',
      transportModel: 'gpt-5.5',
      label: 'GPT-5.5',
    } as ModelOption;
    const options = {
      codex: [option],
      copilot: [{
        canonicalModel: 'openai/auto',
        transportModel: 'auto',
        label: 'Auto',
      } as ModelOption],
    };

    expect(modelOptionValue(option)).toBe('openai/gpt-5.5');
    expect(omitProviderModelOptions(options, 'codex')).toEqual({
      copilot: options.copilot,
    });
    expect(options.codex).toEqual([option]);
  });

  it('does not cache an empty failed OAuth catalog', () => {
    expect(() => requireCacheableModelOptions({
      source: 'dynamic',
      models: [],
      error: 'OAuth catalog unavailable',
    })).toThrow('OAuth catalog unavailable');
    expect(() => requireCacheableModelOptions({
      source: 'static',
      models: [{
        canonicalModel: 'deepseek/deepseek-v4-flash',
        transportModel: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
      }],
      error: 'dynamic catalog unavailable',
    })).not.toThrow();
  });
});
