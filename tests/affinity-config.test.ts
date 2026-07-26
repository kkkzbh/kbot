import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('affinity configuration', () => {
  it('loads the affinity runtime plugin before long-term memory', () => {
    const content = readFileSync(resolve(process.cwd(), 'koishi.yml'), 'utf8');
    const affinityIndex = content.indexOf('./dist/plugins/affinity:affinity:');
    const memoryIndex = content.indexOf('./dist/plugins/memory:memory:');

    expect(affinityIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeGreaterThan(affinityIndex);
    expect(content).toContain('randomWindowStartHour: ${{ +env.AFFINITY_RANDOM_WINDOW_START_HOUR || 8 }}');
    expect(content).toContain('randomWindowEndHour: ${{ +env.AFFINITY_RANDOM_WINDOW_END_HOUR || 22 }}');
  });

  it('exposes relationship events in the independent admin workspace', () => {
    const router = readFileSync(resolve(process.cwd(), 'apps/admin-web/src/router.ts'), 'utf8');
    const page = readFileSync(resolve(process.cwd(), 'apps/admin-web/src/pages/AffinityPage.vue'), 'utf8');

    expect(router).toContain("path: '/intelligence/affinity'");
    expect(router).toContain("title: '关系事件'");
    expect(page).toContain("rawApi('/affinity')");
    expect(page).toContain('affinity.analysis');
    expect(page).toContain('href="/intelligence/models"');
    expect(page).not.toContain('settings.analysisModel');
    expect(page).not.toContain('analysisModelApiKey');
  });
});
