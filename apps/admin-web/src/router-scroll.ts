export type AdminScrollRoute = {
  path: string;
  hash: string;
};

export type AdminSavedScrollPosition = {
  left: number;
  top: number;
};

export function resolveAdminScroll(
  to: AdminScrollRoute,
  from: AdminScrollRoute,
  savedPosition: AdminSavedScrollPosition | null,
) {
  if (savedPosition) return savedPosition;
  if (to.hash) {
    return {
      el: to.hash,
      top: 72,
      behavior: 'smooth' as const,
    };
  }
  if (to.path === from.path) return false;
  return { top: 0 };
}
