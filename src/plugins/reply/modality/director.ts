import type { TurnInput } from '../pipeline/types.js';

export type VoiceAdmissionReason =
  | 'explicit_request'
  | 'voice_reply'
  | 'private_social_moment'
  | 'not_admitted';

export type StickerAdmissionReason =
  | 'explicit_request'
  | 'casual_reaction'
  | 'not_admitted';

export interface ModalityTransportCapabilities {
  canVoice: boolean;
  canSticker: boolean;
  stickerAvailableCount: number;
}

export interface ModalityPolicySnapshot {
  canVoice: boolean;
  canSticker: boolean;
  voiceReason: VoiceAdmissionReason;
  stickerReason: StickerAdmissionReason;
}

export interface ModalityPreferenceSnapshot {
  voiceAutomatic: boolean;
  stickerAutomatic: boolean;
}

export const DEFAULT_MODALITY_PREFERENCE: Readonly<ModalityPreferenceSnapshot> = Object.freeze({
  voiceAutomatic: true,
  stickerAutomatic: true,
});

export interface ModalityTurnInput {
  turnId: string;
  conversationKey: string;
  input: TurnInput;
  transport: ModalityTransportCapabilities;
  preference: ModalityPreferenceSnapshot;
}

interface ConversationModalityState {
  turn: number;
  lastStickerTurn: number | null;
  lastVoiceTurn: number | null;
  lastTouchedAt: number;
}

interface ActiveModalityTurn {
  conversationKey: string;
  turn: number;
  snapshot: ModalityPolicySnapshot;
}

export interface ModalityDirectorOptions {
  stickerCooldownTurns?: number;
  voiceCooldownTurns?: number;
  maxConversationStates?: number;
  now?: () => number;
}

const VOICE_REQUEST_PATTERNS = [
  /(?:^|[，。！？；\s])(?:请|麻烦)?(?:只|就)?(?:给我|回我|回复我)?(?:用|发|来|录)(?:一|几)?(?:条|段|个|句)?(?:语音|录音)(?:说|讲|回答|回复|念|读|唱)?/u,
  /(?:请|麻烦|能不能|可不可以|要不|还是)(?:给我)?(?:用|发|来|录)(?:一|几)?(?:条|段|个)?(?:语音|录音)/u,
  /可以给我(?:用|发|来|录)(?:一|几)?(?:条|段|个)?(?:语音|录音)/u,
  /可以用(?:语音|录音)(?:给我|回我|回复我|回答我|说给我听)/u,
  /(?:给我|回我|回复我)(?:用|发|来|录)?(?:一|几)?(?:条|段|个)?(?:语音|录音)/u,
  /(?:^|[，。！？\s])用(?:语音|录音)(?:给我|回我|回复我|回答我|说给我听)/u,
  /(?:^|[，。！？\s])来(?:一|几)?(?:条|段)?(?:语音|录音)/u,
  /(?:发|录)(?:一|几)?(?:条|段)?(?:语音|录音)(?:给我|回我)/u,
  /(?:语音|录音)(?:回|回复)(?:我|一下)/u,
  /(?:说给我听|念给我听|读给我听|唱(?:一|几)?句(?:给我听)?|想听你(?:说|念|读|唱))/u,
] as const;
const VOICE_OPTOUT_PATTERN = /(?:(?:别|不要|不用|禁止).{0,8}(?:语音|录音)|(?:语音|录音).{0,8}(?:别|不要|不用))/u;
const STICKER_REQUEST_PATTERNS = [
  /(?:^|[，。！？；\s])(?:请|麻烦)?(?:只|就|再)?(?:给我|回我)?(?:发|来|整|配|用)(?:一|几)?(?:张|个|些|点)?(?:表情包|贴图|meme|梗图)/iu,
  /(?:请|麻烦|能不能|可不可以|要不|再)(?:给我)?(?:发|来|整|用)(?:一|几)?(?:张|个|些|点)?(?:表情包|贴图|meme|梗图)/iu,
  /可以给我(?:发|来|整|用)(?:一|几)?(?:张|个|些|点)?(?:表情包|贴图|meme|梗图)/iu,
  /可以(?:发|整)(?:一|几)?(?:张|个)?(?:表情包|贴图|meme|梗图)(?:给我|回我)/iu,
  /给我(?:发|来|整|用)(?:一|几)?(?:张|个|些|点)?(?:表情包|贴图|meme|梗图)/iu,
  /(?:^|[，。！？\s])(?:来|整)(?:一|几)?(?:张|个|些)?(?:表情包|贴图|meme|梗图)/iu,
  /(?:发|整)(?:一|几)?(?:张|个)?(?:表情包|贴图|meme|梗图)(?:给我|回我)/iu,
] as const;
const STICKER_OPTOUT_PATTERN = /(?:(?:别|不要|不用|禁止).{0,8}(?:表情包|贴图|meme|梗图)|(?:表情包|贴图|meme|梗图).{0,8}(?:别|不要|不用))/iu;
const SERIOUS_CONTEXT_PATTERN = /(?:自杀|轻生|不想活|死亡|去世|葬礼|重病|急诊|住院|流产|性侵|强奸|猥亵|家暴|虐待|事故|报警|诈骗|泄露|密码|账号被盗|被欺负|霸凌|抑郁|崩溃|伤害自己|违法|法律责任)/u;
const INFORMATION_TASK_PATTERN = /(?:查一下|查查|搜索|搜一下|联网|资料|来源|链接|代码|报错|教程|步骤|总结|整理|比较|分析|解释|为什么|是什么|怎么做|如何|列出|计算|证明|作业|论文|文档|格式|功能|制作|支持)/u;
const SOCIAL_VOICE_PATTERN = /(?:晚安|生日快乐|祝你|恭喜|想你|想听你说|安慰我|难过|委屈|想哭|撑不住|好累|累死|害怕|紧张|失眠)/u;
const CASUAL_REACTION_PATTERN = /(?:哈哈|笑死|绷不住|离谱|无语|好耶|太好了|生日快乐|恭喜|可爱|笨蛋|哼|怎么这样|喜欢|想你|贴贴|厉害|绝了|真的假的|呜呜|嘿嘿|欸|诶)/u;
const EXCLUSIVE_VOICE_REQUEST_PATTERN = /(?:(?:只|就)(?:给我|回我)?(?:用|发|来|录)?.{0,6}(?:语音|录音)|(?:语音|录音).{0,8}(?:就行|就好|即可)|(?:别|不要|不用)发?(?:文字|文本))/u;
const VOICE_WITH_TEXT_REQUEST_PATTERN = /(?:(?:链接|网址|地址|代码|清单|步骤).{0,10}(?:发|用|写成)?(?:文字|文本)|(?:另外|同时|再|然后).{0,10}(?:发|用|写)?(?:文字|文本))/u;

function requireIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`modality director requires ${label}.`);
  return normalized;
}

function cooldownReady(lastTurn: number | null, currentTurn: number, cooldownTurns: number): boolean {
  return lastTurn == null || currentTurn - lastTurn > cooldownTurns;
}

function resolveVoiceReason(input: TurnInput): VoiceAdmissionReason {
  if (VOICE_OPTOUT_PATTERN.test(input.text)) return 'not_admitted';
  if (VOICE_REQUEST_PATTERNS.some((pattern) => pattern.test(input.text))) return 'explicit_request';
  if (input.hasVoiceInput) return 'voice_reply';
  if (input.isDirect && SOCIAL_VOICE_PATTERN.test(input.text) && !INFORMATION_TASK_PATTERN.test(input.text)) {
    return 'private_social_moment';
  }
  return 'not_admitted';
}

export function isExclusiveVoiceRequest(text: string): boolean {
  return EXCLUSIVE_VOICE_REQUEST_PATTERN.test(text) && !VOICE_WITH_TEXT_REQUEST_PATTERN.test(text);
}

function resolveStickerReason(input: TurnInput): StickerAdmissionReason {
  if (STICKER_OPTOUT_PATTERN.test(input.text) || SERIOUS_CONTEXT_PATTERN.test(input.text)) {
    return 'not_admitted';
  }
  if (STICKER_REQUEST_PATTERNS.some((pattern) => pattern.test(input.text))) return 'explicit_request';
  if (INFORMATION_TASK_PATTERN.test(input.text)) return 'not_admitted';
  if (CASUAL_REACTION_PATTERN.test(input.text)) {
    return 'casual_reaction';
  }
  return 'not_admitted';
}

export function deriveModalityPolicy(
  input: TurnInput,
  transport: ModalityTransportCapabilities,
  cooldown: { stickerReady: boolean; voiceReady: boolean },
  preference: ModalityPreferenceSnapshot,
): ModalityPolicySnapshot {
  const voiceReason = resolveVoiceReason(input);
  const stickerReason = resolveStickerReason(input);
  const voiceBypassesCooldown = voiceReason === 'explicit_request' || voiceReason === 'voice_reply';
  const stickerBypassesCooldown = stickerReason === 'explicit_request';
  const voicePreferenceAllows = preference.voiceAutomatic || voiceReason === 'explicit_request';
  const stickerPreferenceAllows = preference.stickerAutomatic || stickerReason === 'explicit_request';

  return {
    canVoice:
      transport.canVoice
      && voiceReason !== 'not_admitted'
      && voicePreferenceAllows
      && (voiceBypassesCooldown || cooldown.voiceReady),
    canSticker:
      transport.canSticker
      && transport.stickerAvailableCount > 0
      && stickerReason !== 'not_admitted'
      && stickerPreferenceAllows
      && (stickerBypassesCooldown || cooldown.stickerReady),
    voiceReason,
    stickerReason,
  };
}

export class ModalityDirector {
  private readonly conversations = new Map<string, ConversationModalityState>();
  private readonly activeTurns = new Map<string, ActiveModalityTurn>();
  private readonly stickerCooldownTurns: number;
  private readonly voiceCooldownTurns: number;
  private readonly maxConversationStates: number;
  private readonly now: () => number;

  constructor(options: ModalityDirectorOptions = {}) {
    this.stickerCooldownTurns = options.stickerCooldownTurns ?? 3;
    this.voiceCooldownTurns = options.voiceCooldownTurns ?? 3;
    this.maxConversationStates = options.maxConversationStates ?? 512;
    this.now = options.now ?? Date.now;
  }

  beginTurn(rawInput: ModalityTurnInput): ModalityPolicySnapshot {
    const turnId = requireIdentity(rawInput.turnId, 'turnId');
    const conversationKey = requireIdentity(rawInput.conversationKey, 'conversationKey');
    const active = this.activeTurns.get(turnId);
    if (active) {
      if (active.conversationKey !== conversationKey) {
        throw new Error(`modality turn ${turnId} changed conversation ownership.`);
      }
      return active.snapshot;
    }

    const current = this.conversations.get(conversationKey) ?? {
      turn: 0,
      lastStickerTurn: null,
      lastVoiceTurn: null,
      lastTouchedAt: this.now(),
    };
    current.turn += 1;
    current.lastTouchedAt = this.now();
    this.conversations.set(conversationKey, current);

    const snapshot = deriveModalityPolicy(rawInput.input, rawInput.transport, {
      stickerReady: cooldownReady(current.lastStickerTurn, current.turn, this.stickerCooldownTurns),
      voiceReady: cooldownReady(current.lastVoiceTurn, current.turn, this.voiceCooldownTurns),
    }, rawInput.preference);
    this.activeTurns.set(turnId, {
      conversationKey,
      turn: current.turn,
      snapshot,
    });
    this.pruneConversations();
    return snapshot;
  }

  recordDelivered(turnId: string, modality: 'sticker' | 'voice'): void {
    const active = this.activeTurns.get(requireIdentity(turnId, 'turnId'));
    if (!active) {
      throw new Error(`modality turn ${turnId} is not active.`);
    }
    const state = this.conversations.get(active.conversationKey);
    if (!state) {
      throw new Error(`modality conversation ${active.conversationKey} is unavailable.`);
    }
    if (modality === 'sticker') state.lastStickerTurn = active.turn;
    else state.lastVoiceTurn = active.turn;
    state.lastTouchedAt = this.now();
  }

  finishTurn(turnId: string): void {
    this.activeTurns.delete(requireIdentity(turnId, 'turnId'));
  }

  private pruneConversations(): void {
    if (this.conversations.size <= this.maxConversationStates) return;
    const activeConversationKeys = new Set(
      [...this.activeTurns.values()].map((turn) => turn.conversationKey),
    );
    const candidates = [...this.conversations.entries()]
      .filter(([key]) => !activeConversationKeys.has(key))
      .sort((left, right) => left[1].lastTouchedAt - right[1].lastTouchedAt);
    const removeCount = this.conversations.size - this.maxConversationStates;
    for (const [key] of candidates.slice(0, removeCount)) {
      this.conversations.delete(key);
    }
  }
}
