import { defineStore } from 'pinia';

export type ApplyState = {
  restartRequired: boolean;
  reasons: string[];
};

export const useRuntimeStore = defineStore('runtime', {
  state: () => ({
    currentModel: '加载中',
    running: 0,
    total: 0,
    openEventCount: 0,
    restartRequired: false,
    restartReasons: [] as string[],
  }),
  actions: {
    updateApply(apply?: ApplyState) {
      if (!apply) return;
      this.restartRequired = apply.restartRequired;
      this.restartReasons = apply.reasons;
    },
  },
});
