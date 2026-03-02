type SessionAuthorLike = {
  nick?: string;
  name?: string;
};

type SessionLike = {
  author?: SessionAuthorLike;
  username?: string;
  userId?: string;
};

const INVISIBLE_OR_CONTROL_RE = /[\p{Cf}\p{Cc}\p{Cs}]/gu;

function normalizeDisplayNameCandidate(value?: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  // Filter out zero-width / control-only names (e.g. U+2062 "⁢"),
  // then fall back to another identifier.
  const visibleText = trimmed.replace(INVISIBLE_OR_CONTROL_RE, '').trim();
  if (!visibleText) return '';
  return trimmed;
}

export function resolveSessionDisplayName(session: SessionLike): string {
  return (
    normalizeDisplayNameCandidate(session.author?.nick) ||
    normalizeDisplayNameCandidate(session.username) ||
    normalizeDisplayNameCandidate(session.author?.name) ||
    normalizeDisplayNameCandidate(session.userId) ||
    '用户'
  );
}
