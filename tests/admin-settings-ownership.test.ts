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
    expect(app).not.toContain("label: '系统设置'");
    expect(router).toContain("path: '/intelligence/natural-trigger'");
    expect(router).not.toContain("path: '/system/basic'");
    expect(router).not.toContain("path: '/system/features'");
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
    expect(policiesPage).not.toContain('CHAT_NATURAL_TRIGGER_ENABLED');
    expect(policiesPage).toContain(
      'useManagedFeatureSettings(runtimeFeatureSettingKeys)',
    );
  });
});
