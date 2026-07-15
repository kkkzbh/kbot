import { defineStore } from 'pinia';

export const useRuntimeStore = defineStore('runtime', {
  state: () => ({
    currentModel: '加载中',
    running: 0,
    total: 0,
    restartRequired: false,
    restartReasons: [] as string[],
  }),
  actions: {
    updateApply(apply?: { restartRequired: boolean; reasons: string[] }) {
      if (!apply) return;
      this.restartRequired = apply.restartRequired;
      this.restartReasons = apply.reasons;
    },
  },
});
