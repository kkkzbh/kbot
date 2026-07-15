import { defineStore } from 'pinia';
import { api, jsonBody } from '@/api/client';
import type { SessionState } from '@contracts';

export const useSessionStore = defineStore('session', {
  state: () => ({
    checked: false,
    authenticated: false,
    expiresAt: null as number | null,
  }),
  actions: {
    async check() {
      const state = await api<SessionState>('/session');
      this.$patch({ checked: true, authenticated: state.authenticated, expiresAt: state.expiresAt });
      return state.authenticated;
    },
    async login(accessToken: string) {
      const state = await api<SessionState>('/session', { method: 'POST', body: jsonBody({ accessToken }) });
      this.$patch({ checked: true, authenticated: state.authenticated, expiresAt: state.expiresAt });
    },
    async logout() {
      await api('/session', { method: 'DELETE' });
      this.$patch({ checked: true, authenticated: false, expiresAt: null });
    },
  },
});
