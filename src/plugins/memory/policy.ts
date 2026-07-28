import type {
  MemoryAddress,
  MemoryAudiencePolicy,
  MemoryHeadState,
  MemorySensitivity,
  MemorySubjectType,
} from '../../types/memory.js';
import { MemoryRuntimeError } from './errors.js';

export interface MemoryPolicyRecord {
  state: MemoryHeadState;
  subjectType: MemorySubjectType;
  subjectKey: string;
  sourceContextKey: string;
  audiencePolicy: MemoryAudiencePolicy;
  audienceContextKeys: readonly string[];
  audienceSnapshots: Readonly<Record<string, readonly string[]>>;
  sensitivity: MemorySensitivity;
  validFrom?: number | null;
  validUntil?: number | null;
  expiresAt?: number | null;
}

export interface MemoryReviewActor {
  userKey: string;
  isDirect: boolean;
  isAdmin?: boolean;
}

function isTemporallyActive(record: MemoryPolicyRecord, now: number): boolean {
  if (record.validFrom != null && record.validFrom > now) return false;
  if (record.validUntil != null && record.validUntil < now) return false;
  if (record.expiresAt != null && record.expiresAt < now) return false;
  return true;
}

function currentAudienceIsCaptured(record: MemoryPolicyRecord, address: MemoryAddress): boolean {
  const currentAudience = address.currentAudienceSubjectKeys;
  return Array.isArray(currentAudience)
    && currentAudience.length > 0
    && Object.values(record.audienceSnapshots).some((snapshot) => {
      const capturedAudience = new Set(snapshot);
      return currentAudience.every((subjectKey) => capturedAudience.has(subjectKey));
    });
}

function audienceAllows(record: MemoryPolicyRecord, address: MemoryAddress): boolean {
  switch (record.audiencePolicy) {
    case 'subjectPrivate':
      return address.channelType === 'direct' && record.subjectType === 'user' && record.subjectKey === address.userKey;
    case 'sourceContext':
      return record.sourceContextKey === address.contextKey;
    case 'captureAudience':
      return currentAudienceIsCaptured(record, address);
    case 'explicitContexts':
      return record.audienceContextKeys.includes(address.contextKey);
    case 'subjectAllContexts':
      return record.subjectType === 'user' && record.subjectKey === address.userKey;
  }
}

export class MemoryPolicyService {
  canRecall(record: MemoryPolicyRecord, address: MemoryAddress, now = Date.now()): boolean {
    if (record.state !== 'active') return false;
    if (record.sensitivity === 'secret') return false;
    if (!isTemporallyActive(record, now)) return false;
    if (address.channelType === 'direct') {
      return record.subjectType === 'user'
        && record.subjectKey === address.userKey
        && (
          record.audiencePolicy === 'subjectPrivate'
          || record.audiencePolicy === 'subjectAllContexts'
          || (
            record.audiencePolicy === 'explicitContexts'
            && record.audienceContextKeys.includes(address.contextKey)
          )
        );
    }
    const currentAudience = address.currentAudienceSubjectKeys;
    if (
      record.sensitivity !== 'low'
      || !Array.isArray(currentAudience)
      || currentAudience.length === 0
    ) {
      return false;
    }
    if (record.subjectType === 'user') {
      if (!currentAudience.includes(record.subjectKey)) return false;
      return audienceAllows(record, address);
    }
    return record.sourceContextKey === address.contextKey
      && record.audiencePolicy === 'sourceContext'
      && currentAudienceIsCaptured(record, address);
  }

  canList(record: MemoryPolicyRecord, address: MemoryAddress, privateExport = false, now = Date.now()): boolean {
    if (privateExport) {
      return address.channelType === 'direct'
        && record.subjectType === 'user'
        && record.subjectKey === address.userKey
        && record.state !== 'forgotten';
    }
    return this.canRecall(record, address, now);
  }

  assertCanReview(
    record: Pick<MemoryPolicyRecord, 'subjectType' | 'subjectKey' | 'state'>,
    actor: MemoryReviewActor,
  ): void {
    if (record.state !== 'pendingReview') {
      throw new MemoryRuntimeError('review', 'validation', 'memory_review_state_invalid', 'Only pending memory can be reviewed.');
    }
    if (actor.isAdmin) return;
    if (!actor.isDirect) {
      throw new MemoryRuntimeError('review', 'authorization', 'memory_review_requires_direct', 'Memory review requires a direct chat.');
    }
    if (record.subjectType !== 'user' || record.subjectKey !== actor.userKey) {
      throw new MemoryRuntimeError('review', 'authorization', 'memory_review_owner_mismatch', 'Only the memory subject can review this memory.');
    }
  }

  assertCanForget(
    record: Pick<MemoryPolicyRecord, 'subjectType' | 'subjectKey'>,
    actor: MemoryReviewActor,
  ): void {
    if (actor.isAdmin) return;
    if (record.subjectType !== 'user' || record.subjectKey !== actor.userKey) {
      throw new MemoryRuntimeError('forget', 'authorization', 'memory_forget_owner_mismatch', 'Only the memory subject can forget this memory.');
    }
  }

  capturePolicy(address: MemoryAddress, sensitivity: MemorySensitivity): {
    audiencePolicy: MemoryAudiencePolicy;
    audienceContextKeys: string[];
    audienceSnapshots: Record<string, string[]>;
  } {
    const currentAudience = [...new Set(
      (address.currentAudienceSubjectKeys ?? [])
        .map((subjectKey) => subjectKey.trim())
        .filter(Boolean),
    )].sort();
    if (
      address.channelType === 'group'
      && sensitivity === 'low'
      && currentAudience.includes(address.userKey)
    ) {
      return {
        audiencePolicy: 'captureAudience',
        audienceContextKeys: [address.contextKey],
        audienceSnapshots: {
          [address.contextKey]: currentAudience,
        },
      };
    }
    return {
      audiencePolicy: 'subjectPrivate',
      audienceContextKeys: [address.contextKey],
      audienceSnapshots: {
        [address.contextKey]: [address.userKey],
      },
    };
  }
}

function parseAudienceKeys(raw: string): string[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new MemoryRuntimeError('recall', 'validation', 'memory_audience_invalid', 'Stored memory audience is invalid.');
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

export const parseAudienceContextKeys = parseAudienceKeys;
export const parseCaptureAudienceSubjectKeys = parseAudienceKeys;

export function parseAudienceSnapshots(raw: string): Record<string, string[]> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemoryRuntimeError('recall', 'validation', 'memory_audience_invalid', 'Stored memory audience snapshots are invalid.');
  }
  const result: Record<string, string[]> = {};
  for (const [contextKey, subjectKeys] of Object.entries(value)) {
    if (!contextKey.trim() || !Array.isArray(subjectKeys) || subjectKeys.length === 0) {
      throw new MemoryRuntimeError('recall', 'validation', 'memory_audience_invalid', 'Stored memory audience snapshots are invalid.');
    }
    result[contextKey] = parseAudienceKeys(JSON.stringify(subjectKeys));
  }
  return result;
}
