import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  naturalTriggerAdminResponseSchema,
  runtimeFeatureSettingKeys,
} from '../src/admin/contracts/index.js';

describe('admin settings ownership', () => {
  it('exposes natural trigger in conversation intelligence without generic system pages', () => {
    const app = readFileSync(resolve(process.cwd(), 'apps/admin-web/src/App.vue'), 'utf8');
    const router = readFileSync(resolve(process.cwd(), 'apps/admin-web/src/router.ts'), 'utf8');

    expect(app).toContain("label: '自然触发', path: '/intelligence/natural-trigger'");
    expect(app).toContain("label: 'Agent', path: '/intelligence/agent'");
    expect(app).not.toContain("label: '系统设置'");
    expect(router).toContain("path: '/intelligence/natural-trigger'");
    expect(router).toContain("path: '/intelligence/agent'");
    expect(router).not.toContain("path: '/policies'");
    expect(router).not.toContain("path: '/system/basic'");
    expect(router).not.toContain("path: '/system/features'");
  });

  it('owns Agent management in QQBot Admin without a Console navigation path', () => {
    const agentPage = readFileSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/AgentPage.vue',
    ), 'utf8');

    expect(agentPage).toContain("rawApi<AgentAdminState>('/agent')");
    expect(agentPage).toContain("{ name: 'mcp', label: 'MCP' }");
    expect(agentPage).toContain("{ name: 'tools', label: 'Tools' }");
    expect(agentPage).toContain("{ name: 'skills', label: 'Skills' }");
    expect(agentPage).toContain("{ name: 'plugins', label: 'Plugin' }");
    expect(agentPage).toContain("rawApi<AgentToolPolicyState>('/agent/tools/policy')");
    expect(agentPage).toContain('useManagedFeatureSettings(fileSystemToolSettingKeys)');
    expect(agentPage).toContain("rawApi('/agent/plugins/computer'");
    expect(agentPage).not.toContain('/policies');
    expect(agentPage).not.toContain('sub-agents');
    expect(agentPage).not.toContain('Agent 调度');
    expect(agentPage).not.toContain('/koishi-console');
    expect(agentPage).not.toContain('ctx.console');
  });

  it('assigns every retired generic field to a domain workspace', () => {
    expect(naturalTriggerAdminResponseSchema).toBeDefined();
    expect(runtimeFeatureSettingKeys).toEqual([
      'QQBOT_REALTIME_MESSAGE_ENABLED',
      'QQBOT_REALTIME_MESSAGE_MAX_INJECT_COUNT',
      'QQBOT_REPLY_INTERRUPT_ENABLED',
    ]);

    const naturalTriggerPage = readFileSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/NaturalTriggerPage.vue',
    ), 'utf8');
    const agentPage = readFileSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/AgentPage.vue',
    ), 'utf8');

    expect(naturalTriggerPage).toContain("api('/natural-trigger'");
    expect(naturalTriggerPage).toContain('draft.mechanisms.alias.aliases');
    expect(naturalTriggerPage).toContain(
      "/intelligence/models?workload=naturalTrigger.decision",
    );
    expect(naturalTriggerPage).toContain(
      'useManagedFeatureSettings(runtimeFeatureSettingKeys)',
    );
    expect(agentPage).toContain('fileSystemToolSettingKeys');
    expect(agentPage).not.toContain('CHAT_NATURAL_TRIGGER_ENABLED');
    expect(agentPage).not.toContain('runtimeFeatureSettingKeys');
    expect(existsSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/PoliciesPage.vue',
    ))).toBe(false);
  });
});
