import { defineStore } from 'pinia';

export type ApplyState = {
  restartRequired: boolean;
  reasons: string[];
};

export type RuntimeOverviewState = {
  currentModel: { model: string; title: string } | null;
  serviceSummary: {
    running: number;
    total: number;
  };
  events: {
    openCount: number;
  };
  apply: ApplyState;
};

export const useRuntimeStore = defineStore('runtime', {
  state: () => ({
    currentModel: '',
    running: 0,
    total: 0,
    openEventCount: 0,
    restartRequired: false,
    restartReasons: [] as string[],
    shellState: 'loading' as 'loading' | 'ready' | 'error',
    shellError: '',
  }),
  actions: {
    updateApply(apply?: ApplyState) {
      if (!apply) return;
      this.restartRequired = apply.restartRequired;
      this.restartReasons = apply.reasons;
    },
    updateOverview(overview: RuntimeOverviewState) {
      this.currentModel = overview.currentModel?.model || '未配置模型';
      this.running = overview.serviceSummary.running;
      this.total = overview.serviceSummary.total;
      this.openEventCount = overview.events.openCount;
      this.updateApply(overview.apply);
      this.shellState = 'ready';
      this.shellError = '';
    },
    markOverviewFailed(message: string) {
      this.shellState = 'error';
      this.shellError = message;
    },
  },
});
