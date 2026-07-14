import type { Session } from 'koishi';

export interface CampusOwnerIdentity {
  ownerKey: string;
  platform: string;
  qqUserId: string;
  channelId: string;
}

export class CampusOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampusOwnerError';
  }
}

export function resolveCampusOwnerIdentity(session: Session): CampusOwnerIdentity {
  const platform = String(session.platform ?? '').trim();
  const qqUserId = String(session.userId ?? '').trim();
  const channelId = String(session.channelId ?? '').trim();
  if (!platform || !qqUserId || !channelId) {
    throw new CampusOwnerError('当前会话缺少 QQ 身份信息，无法使用校园账号功能。');
  }
  return { ownerKey: `${platform}:${qqUserId}`, platform, qqUserId, channelId };
}
