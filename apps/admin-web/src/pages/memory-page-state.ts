export interface MemoryUserSelection {
  userKey: string;
}

export function resolveVisibleUserSelection(
  users: MemoryUserSelection[],
  currentUserKey: string,
): string {
  if (users.some((user) => user.userKey === currentUserKey)) {
    return currentUserKey;
  }
  return users[0]?.userKey || '';
}
