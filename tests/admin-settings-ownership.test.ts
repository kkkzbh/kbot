import { readFileSync } from 'node:fs';
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
    expect(app).toContain("label: 'Agent 能力', path: '/intelligence/agent'");
    expect(app).not.toContain("label: '系统设置'");
    expect(router).toContain("path: '/intelligence/natural-trigger'");
    expect(router).toContain("path: '/intelligence/agent'");
    expect(router).not.toContain("path: '/system/basic'");
    expect(router).not.toContain("path: '/system/features'");
  });

  it('owns Agent management in QQBot Admin without a Console navigation path', () => {
    const agentPage = readFileSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/AgentPage.vue',
    ), 'utf8');

    expect(agentPage).toContain("rawApi<AgentAdminState>('/agent')");
    expect(agentPage).toContain("label: 'Runtime Tools'");
    expect(agentPage).toContain("label: 'Agent 调度'");
    expect(agentPage).toContain('to="/policies"');
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
    const policiesPage = readFileSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/PoliciesPage.vue',
    ), 'utf8');

    expect(naturalTriggerPage).toContain("api('/natural-trigger'");
    expect(naturalTriggerPage).toContain('draft.mechanisms.alias.aliases');
    expect(naturalTriggerPage).toContain(
      "/intelligence/models?workload=naturalTrigger.decision",
    );
    expect(naturalTriggerPage).toContain(
      'useManagedFeatureSettings(runtimeFeatureSettingKeys)',
    );
    expect(policiesPage).not.toContain('CHAT_NATURAL_TRIGGER_ENABLED');
    expect(policiesPage).not.toContain('runtimeFeatureSettingKeys');
    expect(policiesPage).not.toContain('功能策略');
    expect(policiesPage).not.toContain('功能范围覆盖');
  });
});
