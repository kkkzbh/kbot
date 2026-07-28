import type {
  MemoryAddress,
  MemoryAudiencePolicy,
  MemoryFactKind,
  MemoryHeadState,
  MemorySensitivity,
} from '../../types/memory.js';
import { MemoryPolicyService } from './policy.js';

export type MemoryCandidateSubject =
  | 'target_user'
  | 'other_speaker'
  | 'group_shared'
  | 'assistant'
  | 'unknown';

export type { MemoryFactKind } from '../../types/memory.js';

export interface ExtractedMemoryCandidate {
  candidateType: 'fact' | 'episode' | 'drop';
  subject: MemoryCandidateSubject;
  ownerSpeakerId?: string | null;
  kind?: MemoryFactKind;
  topicKey?: string;
  content?: string;
  title?: string;
  summary?: string;
  keywords: string[];
  importance: number;
  confidence: number;
  sensitivity: MemorySensitivity;
  applicability?: string | null;
  evidence?: string | null;
  evidenceMessageIds?: string[];
  evidenceSpeakerIds?: string[];
  conflictHint?: string | null;
  periodStart?: string | number | null;
  periodEnd?: string | number | null;
  validFrom?: string | number | null;
  validUntil?: string | number | null;
  expiresAt?: string | number | null;
  dropReason?: string | null;
}

export interface MemoryCaptureDecision {
  state: MemoryHeadState | 'rejected';
  sensitivity: MemorySensitivity;
  audiencePolicy: MemoryAudiencePolicy;
  audienceContextKeys: string[];
  audienceSnapshots: Record<string, string[]>;
  reasonCode: string | null;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{16,}\b/,
  /\b(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}/i,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9_\-./+=]{12,}/i,
];

const PII_PATTERNS = [
  /\b1[3-9]\d{9}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{15}(\d{2}[0-9Xx])?\b/,
];

const THIRD_PARTY_PRIVACY_PATTERN = /(?:他|她|别人|朋友|同学|同事|群友|室友|家人|妈妈|爸爸).{0,16}(?:手机号|电话|地址|密码|身份证|隐私|病|收入|账号)/;
const GROUP_JOKE_PATTERN = /(?:玩笑|开玩笑|梗|外号|乳名|迫害|roleplay|角色扮演|群友说|大家叫|起哄|整活|meme)/i;

function candidateText(candidate: ExtractedMemoryCandidate): string {
  return [candidate.content, candidate.title, candidate.summary, candidate.evidence, candidate.dropReason]
    .filter((item): item is string => typeof item === 'string')
    .join('\n');
}

function maxSensitivity(left: MemorySensitivity, right: MemorySensitivity): MemorySensitivity {
  const rank: Record<MemorySensitivity, number> = {
    low: 0,
    personal: 1,
    sensitive: 2,
    secret: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

export function runDeterministicCaptureGuard(
  candidate: ExtractedMemoryCandidate,
  address: MemoryAddress,
  policy = new MemoryPolicyService(),
): MemoryCaptureDecision {
  const text = candidateText(candidate);
  if (!text.trim()) {
    return {
      state: 'rejected',
      sensitivity: candidate.sensitivity,
      audiencePolicy: 'sourceContext',
      audienceContextKeys: [address.contextKey],
      audienceSnapshots: { [address.contextKey]: [address.userKey] },
      reasonCode: 'empty_candidate',
    };
  }
  if (candidate.candidateType === 'drop') {
    return {
      state: 'rejected',
      sensitivity: candidate.sensitivity,
      audiencePolicy: 'sourceContext',
      audienceContextKeys: [address.contextKey],
      audienceSnapshots: { [address.contextKey]: [address.userKey] },
      reasonCode: 'provider_drop',
    };
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text)) || candidate.sensitivity === 'secret') {
    return {
      state: 'rejected',
      sensitivity: 'secret',
      audiencePolicy: 'subjectPrivate',
      audienceContextKeys: [address.contextKey],
      audienceSnapshots: { [address.contextKey]: [address.userKey] },
      reasonCode: 'secret_guard',
    };
  }

  let sensitivity: MemorySensitivity = candidate.sensitivity;
  let state: MemoryHeadState = 'active';
  let reasonCode: string | null = null;
  if (PII_PATTERNS.some((pattern) => pattern.test(text))) {
    sensitivity = maxSensitivity(sensitivity, 'sensitive');
    state = 'pendingReview';
    reasonCode = 'pii_guard';
  }
  if (THIRD_PARTY_PRIVACY_PATTERN.test(text)) {
    sensitivity = maxSensitivity(sensitivity, 'sensitive');
    state = 'pendingReview';
    reasonCode ??= 'third_party_privacy_guard';
  }
  if (address.channelType === 'group' && GROUP_JOKE_PATTERN.test(text)) {
    sensitivity = maxSensitivity(sensitivity, 'personal');
    state = 'pendingReview';
    reasonCode ??= 'group_joke_guard';
  }
  if (candidate.kind === 'trait') {
    sensitivity = maxSensitivity(sensitivity, 'personal');
    state = 'pendingReview';
    reasonCode ??= 'quality-review';
  }
  if (candidate.conflictHint?.trim()) {
    state = 'pendingReview';
    reasonCode ??= 'quality-review';
  }
  const audience = policy.capturePolicy(address, sensitivity);
  return {
    state,
    sensitivity,
    ...audience,
    reasonCode,
  };
}
