import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chatluna search service wiring', () => {
  it('uses upstream chatluna-search-service with Tavily and canonical model binding', () => {
    const content = readFileSync(resolve(process.cwd(), 'koishi.yml'), 'utf8');

    expect(content).toContain('chatluna-search-service:search:');
    expect(content).toContain("enabled: ${{ env.CHATLUNA_SEARCH_SERVICE_ENABLED !== 'false' }}");
    expect(content).toContain('searchEngine:');
    expect(content).toContain('        - tavily');
    expect(content).toContain("topK: ${{ +env.CHATLUNA_SEARCH_SERVICE_TOPK || 5 }}");
    expect(content).toContain("summaryType: ${{ env.CHATLUNA_SEARCH_SERVICE_SUMMARY_TYPE || 'balanced' }}");
    expect(content).toContain("tavilyApiKey: ${{ env.CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY || '' }}");
    expect(content).not.toContain('summaryModel:');
    expect(content).not.toContain('CHATLUNA_SEARCH_SERVICE_SUMMARY_MODEL');

    expect(content).not.toContain('./dist/plugins/web-search:search:');
    expect(content).not.toContain('WEB_SEARCH_');
  });

  it('ships only current search-service env keys in example files', () => {
    const files = ['.env.example', '.env.server.example'];

    for (const file of files) {
      const content = readFileSync(resolve(process.cwd(), file), 'utf8');

      expect(content).toContain('CHATLUNA_SEARCH_SERVICE_ENABLED=true');
      expect(content).toContain('CHATLUNA_SEARCH_SERVICE_TOPK=5');
      expect(content).toContain('CHATLUNA_SEARCH_SERVICE_SUMMARY_TYPE=balanced');
      expect(content).toContain('CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY=');
      expect(content).not.toContain('CHATLUNA_SEARCH_SERVICE_SUMMARY_MODEL');
      expect(content).not.toContain('WEB_SEARCH_');
    }
  });

  it('loads upstream search service in smoke startup script and rejects the deleted local plugin', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/smoke-koishi-start.sh'), 'utf8');

    expect(content).toContain('CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY');
    expect(content).toContain("'chatluna-search-service:search'");
    expect(content).toContain('loader apply plugin chatluna-search-service:search');
    expect(content).toContain('unexpectedly loaded deleted local web-search plugin');
    expect(content).not.toContain('WEB_SEARCH_LLM_PLANNER_ENABLED');
    expect(content).not.toContain('WEB_SEARCH_LLM_RERANK_ENABLED');
  });

  it('keeps the real bot prompts unchanged and validates answers locally', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/smoke-chat-replies.sh'), 'utf8');

    expect(content).toContain('run_case "联网固定URL研究" "no-meta"');
    expect(content).toContain('https://example.com/');
    expect(content).toContain('QQBOT_RUN_SEARCH_DIAGNOSTIC');
    expect(content).toContain('run_case_optional "联网搜索诊断" "no-meta" "液态玻璃是什么？" "macos26-ui"');
    expect(content).toContain('expected semantic match for Example Domain');
    expect(content).toContain('expected semantic match for MacOS26 UI');
  });

  it('keeps runtime search policy out of the sakiko persona preset', () => {
    const content = readFileSync(resolve(process.cwd(), 'data/chathub/role-presets/sakiko.yml'), 'utf8');

    expect(content).not.toContain('# 联网搜索与工具规则');
    expect(content).not.toContain('优先调用 `web_search`');
    expect(content).not.toContain('遇到“X是谁”“X是什么”这类身份/概念问题时');
    expect(content).not.toContain('先搜索当前主流语境下最常见的所指，再回答');
  });

  it('declares the upstream search service dependency', () => {
    const content = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');

    expect(content).toContain('"koishi-plugin-chatluna-search-service": "link:../chatluna/packages/service-search"');
  });
});
