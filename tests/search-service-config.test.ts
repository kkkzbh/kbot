import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chatluna search service wiring', () => {
  it('configures live web_run with required capabilities and no search LLM', () => {
    const content = readFileSync(resolve(process.cwd(), 'koishi.yml'), 'utf8');

    expect(content).toContain('chatluna-web-run-service:web:');
    expect(content).toContain("enabled: ${{ env.CHATLUNA_SEARCH_SERVICE_ENABLED !== 'false' }}");
    expect(content).toContain("mode: ${{ env.CHATLUNA_SEARCH_SERVICE_MODE || 'live' }}");
    expect(content).toContain('requiredCapabilities:');
    for (const capability of ['search_query', 'open', 'click', 'find']) {
      expect(content).toContain(`        - ${capability}`);
    }
    expect(content).toContain("topK: ${{ +env.CHATLUNA_SEARCH_SERVICE_TOPK || 5 }}");
    expect(content).toContain("perDomainLimit: ${{ +env.CHATLUNA_SEARCH_SERVICE_PER_DOMAIN_LIMIT || 2 }}");
    expect(content).toContain("tavilyApiKey: ${{ env.CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY || '' }}");
    expect(content).toContain('request: false');
    expect(content).toContain('actions: false');
    expect(content).not.toContain('summaryType:');
    expect(content).not.toContain('searchEngine:');
    expect(content).not.toContain('name: weather.geo');
    expect(content).not.toContain('name: weather.forecast');

    expect(content).not.toContain('./dist/plugins/web-search:search:');
    expect(content).not.toContain('WEB_SEARCH_');
  });

  it('ships only current search-service env keys in example files', () => {
    const files = ['.env.example', '.env.server.example'];

    for (const file of files) {
      const content = readFileSync(resolve(process.cwd(), file), 'utf8');

      expect(content).toContain('CHATLUNA_SEARCH_SERVICE_ENABLED=true');
      expect(content).toContain('CHATLUNA_SEARCH_SERVICE_MODE=live');
      expect(content).toContain('CHATLUNA_SEARCH_SERVICE_TOPK=5');
      expect(content).toContain('CHATLUNA_SEARCH_SERVICE_PER_DOMAIN_LIMIT=2');
      expect(content).toContain('CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY=');
      expect(content).toContain('CHATLUNA_SEARCH_SERVICE_ARTIFACT_DIR=');
      expect(content).not.toContain('CHATLUNA_SEARCH_SERVICE_SUMMARY_TYPE');
      expect(content).not.toContain('CHATLUNA_COMMON_REQUEST');
      expect(content).not.toContain('CHATLUNA_COMMON_ACTIONS');
      expect(content).not.toContain('WEB_SEARCH_');
    }
  });

  it('loads upstream search service in smoke startup script and rejects the deleted local plugin', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/smoke-koishi-start.sh'), 'utf8');

    expect(content).toContain('CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY');
    expect(content).toContain('CHATLUNA_SEARCH_SERVICE_MODE');
    expect(content).toContain("'chatluna-web-run-service:web'");
    expect(content).toContain('loader apply plugin chatluna-web-run-service:web');
    expect(content).toContain('unexpectedly loaded deleted local web-search plugin');
    expect(content).not.toContain('WEB_SEARCH_LLM_PLANNER_ENABLED');
    expect(content).not.toContain('WEB_SEARCH_LLM_RERANK_ENABLED');
  });

  it('uses the shared live-search probe and validates progress locally', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'scripts/chat-reply-probe-cases.json'), 'utf8'),
    ) as {
      cases: Array<{
        id: string;
        prompt: string;
        dimensions: string[];
        expect: { requireProgress?: boolean };
      }>;
    };
    const searchCase = manifest.cases.find((probeCase) => probeCase.id === 'search-with-progress');
    expect(searchCase).toEqual(expect.objectContaining({
      prompt: 'saki 帮我查一下今天新加坡的天气，再告诉我出门要不要带伞。',
      dimensions: ['search', 'progress'],
      expect: expect.objectContaining({ requireProgress: true }),
    }));
  });

  it('keeps runtime search policy out of the sakiko persona preset', () => {
    const content = readFileSync(resolve(process.cwd(), 'data/chathub/role-presets/sakiko.yml'), 'utf8');

    expect(content).not.toContain('# 联网搜索与工具规则');
    expect(content).not.toContain('优先调用 `web_run`');
    expect(content).not.toContain('遇到“X是谁”“X是什么”这类身份/概念问题时');
    expect(content).not.toContain('先搜索当前主流语境下最常见的所指，再回答');
  });

  it('declares the upstream search service dependency', () => {
    const content = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');

    expect(content).toContain('"koishi-plugin-chatluna-web-run-service": "link:../chatluna/packages/service-web-run"');
  });

  it('migrates the tool catalog and Sydney instructions to web_run only', () => {
    const catalog = readFileSync(resolve(process.cwd(), 'src/plugins/shared/tool-policy-catalog.ts'), 'utf8');
    const sydney = readFileSync(resolve(process.cwd(), 'data/chathub/role-presets/sydney.yml'), 'utf8');
    for (const content of [catalog, sydney]) {
      expect(content).toContain('web_run');
      expect(content).not.toContain('web_search');
      expect(content).not.toContain('web_browser');
      expect(content).not.toContain('web_fetch');
      expect(content).not.toContain('web_post');
    }
  });
});
