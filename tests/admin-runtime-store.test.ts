import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRuntimeStore } from '../apps/admin-web/src/stores/runtime.js';

describe('admin runtime shell state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('hydrates the global shell from the route-independent overview response', () => {
    const runtime = useRuntimeStore();

    runtime.updateOverview({
      currentModel: { model: 'qqbot-codex/gpt-5.6-luna', title: 'Codex OAuth' },
      serviceSummary: { running: 6, total: 6 },
      events: { openCount: 4 },
      apply: { restartRequired: true, reasons: ['model'] },
    });

    expect(runtime.shellState).toBe('ready');
    expect(runtime.currentModel).toBe('qqbot-codex/gpt-5.6-luna');
    expect([runtime.running, runtime.total]).toEqual([6, 6]);
    expect(runtime.openEventCount).toBe(4);
    expect(runtime.restartReasons).toEqual(['model']);
  });

  it('exposes a failed shell refresh without presenting zero services as live state', () => {
    const runtime = useRuntimeStore();

    runtime.markOverviewFailed('overview request failed');

    expect(runtime.shellState).toBe('error');
    expect(runtime.shellError).toBe('overview request failed');
  });
});
