type SessionAuthorLike = {
  nick?: string;
  name?: string;
};

type SessionLike = {
  author?: SessionAuthorLike;
  username?: string;
  userId?: string;
};

export function resolveSessionDisplayName(session: SessionLike): string {
  return session.author?.nick?.trim() || session.username || session.author?.name || session.userId || '用户';
}
