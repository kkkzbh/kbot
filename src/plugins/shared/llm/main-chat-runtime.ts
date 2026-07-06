import {
  type MainChatRuntimeProfile,
  resolveMainChatRuntimeProfileFromEnv,
} from './main-chat-tabs.js';

function sameRuntimeEndpoint(left: MainChatRuntimeProfile, right: MainChatRuntimeProfile): boolean {
  return (
    left.tabId === right.tabId &&
    left.provider === right.provider &&
    left.baseUrl.trim() === right.baseUrl.trim() &&
    left.apiKey.trim() === right.apiKey.trim()
  );
}

export class MainChatRuntimeState {
  private profile: MainChatRuntimeProfile;
  private generation = 0;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.profile = resolveMainChatRuntimeProfileFromEnv(env as Record<string, string>);
  }

  getProfile(): MainChatRuntimeProfile {
    return this.profile;
  }

  getGeneration(): number {
    return this.generation;
  }

  initialize(profile: MainChatRuntimeProfile): void {
    this.profile = profile;
    this.generation = 0;
  }

  hotSwitchModel(nextProfile: MainChatRuntimeProfile): boolean {
    if (!sameRuntimeEndpoint(this.profile, nextProfile)) {
      throw new Error('主聊天模型热切换只能修改当前已加载 provider 的模型名。');
    }
    if (this.profile.canonicalModel === nextProfile.canonicalModel) {
      return false;
    }
    this.profile = nextProfile;
    this.generation += 1;
    return true;
  }
}

export const mainChatRuntimeState = new MainChatRuntimeState();

export function canHotSwitchMainChatModelOnly(
  current: MainChatRuntimeProfile,
  next: MainChatRuntimeProfile,
): boolean {
  if (!sameRuntimeEndpoint(current, next) || current.canonicalModel === next.canonicalModel) return false;
  return next.tabId !== 'codex' && next.tabId !== 'copilot';
}
