import { describe, expect, it, vi } from 'vitest';
import { runLogoutFlow } from '../apps/admin-web/src/logout-flow.js';

describe('admin logout flow', () => {
  it('keeps the authenticated session when the current dirty page rejects navigation', async () => {
    const logout = vi.fn(async () => undefined);
    const navigateToLogin = vi.fn(async () => undefined);

    await expect(runLogoutFlow({
      prepareLeave: async () => false,
      logout,
      navigateToLogin,
    })).resolves.toBe('cancelled');

    expect(logout).not.toHaveBeenCalled();
    expect(navigateToLogin).not.toHaveBeenCalled();
  });

  it('logs out only after the current page accepts navigation', async () => {
    const order: string[] = [];

    await expect(runLogoutFlow({
      prepareLeave: async () => {
        order.push('leave');
        return true;
      },
      logout: async () => {
        order.push('logout');
      },
      navigateToLogin: async () => {
        order.push('login');
      },
    })).resolves.toBe('logged_out');

    expect(order).toEqual(['leave', 'logout', 'login']);
  });
});
