export interface LogoutFlow {
  prepareLeave(): Promise<boolean>;
  logout(): Promise<void>;
  navigateToLogin(): Promise<void>;
}

export async function runLogoutFlow(flow: LogoutFlow): Promise<'cancelled' | 'logged_out'> {
  if (!await flow.prepareLeave()) return 'cancelled';
  await flow.logout();
  await flow.navigateToLogin();
  return 'logged_out';
}
