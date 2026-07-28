import { describe, expect, it } from 'vitest';
import {
  runDeterministicCaptureGuard,
  type ExtractedMemoryCandidate,
} from '../src/plugins/memory/gates.js';
import { groupAddress } from './memory-v3-runtime.js';

function candidate(
  overrides: Partial<ExtractedMemoryCandidate> = {},
): ExtractedMemoryCandidate {
  return {
    candidateType: 'fact',
    subject: 'target_user',
    ownerSpeakerId: '10001',
    kind: 'preference',
    topicKey: 'music',
    content: '小祥喜欢古典音乐。',
    keywords: ['音乐'],
    importance: 0.8,
    confidence: 0.95,
    sensitivity: 'low',
    evidenceMessageIds: ['message:1'],
    evidenceSpeakerIds: ['10001'],
    ...overrides,
  };
}

describe('Memory V3 deterministic capture gates', () => {
  it('rejects secrets before persistence', () => {
    expect(runDeterministicCaptureGuard(candidate({
      content: 'api_key=super-secret-token-value',
    }), groupAddress('group-a'))).toMatchObject({
      state: 'rejected',
      sensitivity: 'secret',
      reasonCode: 'secret_guard',
    });
  });

  it.each([
    ['PII', { content: '我的电话是 13800138000' }, 'pii_guard'],
    ['third-party privacy', { content: '我同学的手机号需要保密' }, 'third_party_privacy_guard'],
    ['group joke', { content: '群里开玩笑叫我猫娘' }, 'group_joke_guard'],
    ['inferred trait', { kind: 'trait' as const }, 'quality-review'],
    ['conflict', { conflictHint: 'conflicts with current head' }, 'quality-review'],
  ])('routes %s to review', (_name, overrides, reasonCode) => {
    expect(runDeterministicCaptureGuard(
      candidate(overrides),
      groupAddress('group-a'),
    )).toMatchObject({
      state: 'pendingReview',
      reasonCode,
    });
  });

  it('activates low-risk attributed group memory with immutable capture audience', () => {
    expect(runDeterministicCaptureGuard(
      candidate(),
      groupAddress('group-a'),
    )).toMatchObject({
      state: 'active',
      sensitivity: 'low',
      audiencePolicy: 'captureAudience',
      audienceSnapshots: {
        'onebot:bot:bot:group:group-a': [
          'onebot:user:10001',
          'onebot:user:10002',
        ],
      },
    });
  });
});
