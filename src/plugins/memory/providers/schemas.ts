import type {
  MemoryCandidateSubject,
  MemoryOutputProtocolId,
  MemorySensitivity,
  MemoryVisibility,
} from '../../../types/memory.js';
import type { ExtractedMemoryCandidate } from '../gates.js';
import { clampScore, uniqueKeywords } from '../format.js';
import { normalizeProfileKind } from './profile-kind.js';

export interface MemoryConversationTurn {
  id: string;
  role: 'human' | 'ai';
  text: string;
  speakerId: string | null;
  speakerName: string | null;
  ownerUserKey: string | null;
  isTarget: boolean;
  attributionSource: 'additional_kwargs' | 'speaker_tag' | 'direct_session' | 'assistant' | 'unknown';
}

const VISIBILITIES = new Set<MemoryVisibility>([
  'global',
  'private_only',
  'source_context_only',
  'allowed_contexts',
  'denied_contexts',
  'pending_review',
  'archived',
]);
const SENSITIVITIES = new Set<MemorySensitivity>(['low', 'personal', 'sensitive', 'secret']);
const SUBJECTS = new Set<MemoryCandidateSubject>(['target_user', 'other_speaker', 'group_shared', 'assistant', 'unknown']);
const SUBJECT_SCHEMA = { type: 'string', enum: ['target_user', 'other_speaker', 'group_shared', 'assistant', 'unknown'] } as const;
const OWNER_AND_EVIDENCE_SCHEMA = {
  ownerSpeakerId: { type: 'string' },
  evidenceMessageIds: { type: 'array', items: { type: 'string' }, maxItems: 12 },
  evidenceSpeakerIds: { type: 'array', items: { type: 'string' }, maxItems: 12 },
} as const;

export const MEMORY_CANDIDATE_JSON_SCHEMA = {
  name: 'memory_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      facts: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: SUBJECT_SCHEMA,
            ...OWNER_AND_EVIDENCE_SCHEMA,
            kind: { type: 'string', enum: ['identity', 'preference', 'trait', 'boundary', 'plan', 'relationship', 'response_policy'] },
            topicKey: { type: 'string' },
            content: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            sensitivity: { type: 'string', enum: ['low', 'personal', 'sensitive', 'secret'] },
            suggestedVisibility: {
              type: 'string',
              enum: ['global', 'private_only', 'source_context_only', 'allowed_contexts', 'denied_contexts', 'pending_review', 'archived'],
            },
            applicability: { type: ['string', 'null'] },
            evidence: { type: ['string', 'null'] },
            conflictHint: { type: ['string', 'null'] },
            validFrom: { type: ['string', 'null'] },
            validUntil: { type: ['string', 'null'] },
            expiresAt: { type: ['string', 'null'] },
          },
          required: [
            'subject',
            'ownerSpeakerId',
            'kind',
            'topicKey',
            'content',
            'keywords',
            'importance',
            'confidence',
            'sensitivity',
            'suggestedVisibility',
            'applicability',
            'evidence',
            'evidenceMessageIds',
            'evidenceSpeakerIds',
            'conflictHint',
            'validFrom',
            'validUntil',
            'expiresAt',
          ],
        },
      },
      episodes: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: SUBJECT_SCHEMA,
            ...OWNER_AND_EVIDENCE_SCHEMA,
            title: { type: 'string' },
            summary: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            periodStart: { type: ['string', 'null'] },
            periodEnd: { type: ['string', 'null'] },
            sensitivity: { type: 'string', enum: ['low', 'personal', 'sensitive', 'secret'] },
            suggestedVisibility: {
              type: 'string',
              enum: ['global', 'private_only', 'source_context_only', 'allowed_contexts', 'denied_contexts', 'pending_review', 'archived'],
            },
            applicability: { type: ['string', 'null'] },
            evidence: { type: ['string', 'null'] },
            validFrom: { type: ['string', 'null'] },
            validUntil: { type: ['string', 'null'] },
            expiresAt: { type: ['string', 'null'] },
          },
          required: [
            'subject',
            'ownerSpeakerId',
            'title',
            'summary',
            'keywords',
            'importance',
            'confidence',
            'periodStart',
            'periodEnd',
            'sensitivity',
            'suggestedVisibility',
            'applicability',
            'evidence',
            'evidenceMessageIds',
            'evidenceSpeakerIds',
            'validFrom',
            'validUntil',
            'expiresAt',
          ],
        },
      },
      drops: {
        type: 'array',
        maxItems: 12,
        items: { type: 'string' },
      },
    },
    required: ['facts', 'episodes', 'drops'],
  },
} as const;

export interface MemoryExtractionTarget {
  speakerId: string;
  speakerName: string | null;
}

function quoteAttr(value: string | null | undefined): string {
  return JSON.stringify(value ?? '');
}

function quoteContent(value: string): string {
  return JSON.stringify(value);
}

function isTrustedTargetTurn(turn: MemoryConversationTurn): boolean {
  return turn.isTarget && (turn.attributionSource === 'additional_kwargs' || turn.attributionSource === 'direct_session');
}

function renderTranscriptLine(turn: MemoryConversationTurn): string {
  if (turn.role === 'ai') {
    return `[assistant message_id=${turn.id} content=${quoteContent(turn.text)}]`;
  }
  const speakerKind = isTrustedTargetTurn(turn) ? 'target' : turn.speakerId ? 'other' : 'unknown_speaker';
  const speakerId = turn.speakerId ?? 'unknown';
  return `[${speakerKind} speaker_id=${speakerId} speaker_name=${quoteAttr(turn.speakerName)} message_id=${turn.id} content=${quoteContent(turn.text)}]`;
}

export function buildMemoryExtractionPrompt(
  turns: MemoryConversationTurn[],
  protocol: MemoryOutputProtocolId,
  target: MemoryExtractionTarget,
): string {
  const transcript = turns.map(renderTranscriptLine).join('\n');
  const base = [
    `提取“助手对目标 speaker 的长期记忆候选”。目标 speaker_id=${target.speakerId} speaker_name=${quoteAttr(target.speakerName)}。`,
    '只允许把 [target ...] 行作为自动写入证据；[other ...]、[unknown_speaker ...]、[assistant ...] 只能作上下文。',
    '不要记录其他群友的信息，也不要把群共享知识库当作个人记忆。',
    '长期记忆候选分为 fact 和 episode。fact kind 只能使用 identity、preference、trait、boundary、plan、relationship、response_policy；兴趣、爱好、喜欢/不喜欢统一用 preference。episode 用于将来值得回忆的用户相关事件。',
    '不要把群聊玩笑、外号、梗、第三方隐私、API key、token、password 写成长期记忆。',
    'visibility 建议：私聊中的低风险稳定用户偏好可 global；私密信息 private_only；群聊来源默认 source_context_only；只有用户明确要求“所有地方都记住”且低风险，群聊记忆才可 global；不确定则 pending_review。',
    'sensitivity 建议：普通偏好 low，个人信息 personal，隐私/健康/账号 sensitive，密钥 secret。',
    '每个 fact/episode 必须设置 subject、ownerSpeakerId、evidenceMessageIds、evidenceSpeakerIds；自动写入候选必须 subject=target_user、ownerSpeakerId 等于目标 speaker_id，证据消息必须来自 target 行。',
  ];

  base.push(
    `输出协议：${protocol}。`,
    '严格按提供的 JSON schema 输出 facts、episodes、drops。',
  );

  return [...base, '对话记录：', transcript].join('\n');
}

function normalizeVisibility(value: unknown): MemoryVisibility | null {
  return typeof value === 'string' && VISIBILITIES.has(value as MemoryVisibility) ? value as MemoryVisibility : null;
}

function normalizeSensitivity(value: unknown): MemorySensitivity | null {
  return typeof value === 'string' && SENSITIVITIES.has(value as MemorySensitivity) ? value as MemorySensitivity : null;
}

function normalizeSubject(value: unknown): MemoryCandidateSubject {
  return typeof value === 'string' && SUBJECTS.has(value as MemoryCandidateSubject) ? value as MemoryCandidateSubject : 'unknown';
}

function normalizeStringArray(value: unknown): string[] {
  return uniqueKeywords(Array.isArray(value) ? value.map(String) : []);
}

function normalizeFact(raw: unknown): ExtractedMemoryCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const kind = normalizeProfileKind(item.kind);
  const content = typeof item.content === 'string' ? item.content.trim() : '';
  const topicKey = typeof item.topicKey === 'string' ? item.topicKey.trim() : '';
  const visibility = normalizeVisibility(item.suggestedVisibility);
  const sensitivity = normalizeSensitivity(item.sensitivity);
  if (!kind || !content || !topicKey || !visibility || !sensitivity) return null;
  return {
    candidateType: 'fact',
    subject: normalizeSubject(item.subject),
    ownerSpeakerId: typeof item.ownerSpeakerId === 'string' ? item.ownerSpeakerId.trim() : null,
    kind,
    topicKey,
    content,
    keywords: uniqueKeywords(Array.isArray(item.keywords) ? item.keywords.map(String) : []),
    importance: clampScore(item.importance, 0.6),
    confidence: clampScore(item.confidence, 0.8),
    sensitivity,
    suggestedVisibility: visibility,
    applicability: typeof item.applicability === 'string' ? item.applicability : null,
    evidence: typeof item.evidence === 'string' ? item.evidence : null,
    evidenceMessageIds: normalizeStringArray(item.evidenceMessageIds),
    evidenceSpeakerIds: normalizeStringArray(item.evidenceSpeakerIds),
    conflictHint: typeof item.conflictHint === 'string' ? item.conflictHint : null,
    validFrom: typeof item.validFrom === 'string' || typeof item.validFrom === 'number' ? item.validFrom : null,
    validUntil: typeof item.validUntil === 'string' || typeof item.validUntil === 'number' ? item.validUntil : null,
    expiresAt: typeof item.expiresAt === 'string' || typeof item.expiresAt === 'number' ? item.expiresAt : null,
  };
}

function normalizeEpisode(raw: unknown): ExtractedMemoryCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
  const visibility = normalizeVisibility(item.suggestedVisibility);
  const sensitivity = normalizeSensitivity(item.sensitivity);
  if (!title || !summary || !visibility || !sensitivity) return null;
  return {
    candidateType: 'episode',
    subject: normalizeSubject(item.subject),
    ownerSpeakerId: typeof item.ownerSpeakerId === 'string' ? item.ownerSpeakerId.trim() : null,
    title,
    summary,
    keywords: uniqueKeywords(Array.isArray(item.keywords) ? item.keywords.map(String) : []),
    importance: clampScore(item.importance, 0.62),
    confidence: clampScore(item.confidence, 0.8),
    sensitivity,
    suggestedVisibility: visibility,
    periodStart: typeof item.periodStart === 'string' || typeof item.periodStart === 'number' ? item.periodStart : null,
    periodEnd: typeof item.periodEnd === 'string' || typeof item.periodEnd === 'number' ? item.periodEnd : null,
    applicability: typeof item.applicability === 'string' ? item.applicability : null,
    evidence: typeof item.evidence === 'string' ? item.evidence : null,
    evidenceMessageIds: normalizeStringArray(item.evidenceMessageIds),
    evidenceSpeakerIds: normalizeStringArray(item.evidenceSpeakerIds),
    validFrom: typeof item.validFrom === 'string' || typeof item.validFrom === 'number' ? item.validFrom : null,
    validUntil: typeof item.validUntil === 'string' || typeof item.validUntil === 'number' ? item.validUntil : null,
    expiresAt: typeof item.expiresAt === 'string' || typeof item.expiresAt === 'number' ? item.expiresAt : null,
  };
}

export function parseMemoryExtractionJson(text: string): ExtractedMemoryCandidate[] {
  const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
  const facts = Array.isArray(parsed.facts) ? parsed.facts.map(normalizeFact).filter(Boolean) : [];
  const episodes = Array.isArray(parsed.episodes) ? parsed.episodes.map(normalizeEpisode).filter(Boolean) : [];
  const drops = Array.isArray(parsed.drops)
    ? parsed.drops.map((item): ExtractedMemoryCandidate | null => {
      const reason = typeof item === 'string' ? item.trim() : '';
      return reason
          ? {
              candidateType: 'drop',
              subject: 'unknown',
              dropReason: reason,
            keywords: [],
            importance: 0,
            confidence: 1,
            sensitivity: 'low',
            suggestedVisibility: 'archived',
          }
        : null;
    }).filter(Boolean)
    : [];
  return [...facts, ...episodes, ...drops] as ExtractedMemoryCandidate[];
}
