import type {
  MemoryAddress,
  MemoryOutputProtocolId,
  MemorySensitivity,
} from '../../../types/memory.js';
import type { ExtractedMemoryCandidate, MemoryCandidateSubject } from '../gates.js';
import { uniqueKeywords } from '../format.js';
import { parseProfileKind } from './profile-kind.js';

export interface MemoryConversationTurn {
  id: string;
  role: 'human' | 'ai';
  text: string;
  speakerId: string | null;
  speakerName: string | null;
  ownerUserKey: string | null;
  isTarget: boolean;
  attributionSource: 'additional_kwargs' | 'speaker_tag' | 'direct_session' | 'assistant' | 'unknown';
  parentId?: string | null;
  occurredAt?: number | null;
}

const SENSITIVITIES = new Set<MemorySensitivity>(['low', 'personal', 'sensitive', 'secret']);
const SUBJECTS = new Set<MemoryCandidateSubject>(['target_user', 'other_speaker', 'group_shared', 'assistant', 'unknown']);
const FACT_SUBJECTS = new Set<MemoryCandidateSubject>(['target_user', 'group_shared', 'assistant']);
const EPISODE_SUBJECTS = new Set<MemoryCandidateSubject>(['target_user']);
const FACT_SUBJECT_SCHEMA = { type: 'string', enum: ['target_user', 'group_shared', 'assistant'] } as const;
const EPISODE_SUBJECT_SCHEMA = { type: 'string', enum: ['target_user'] } as const;
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
            subject: FACT_SUBJECT_SCHEMA,
            ...OWNER_AND_EVIDENCE_SCHEMA,
            kind: { type: 'string', enum: ['identity', 'preference', 'trait', 'boundary', 'plan', 'relationship', 'response_policy'] },
            topicKey: { type: 'string' },
            content: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            sensitivity: { type: 'string', enum: ['low', 'personal', 'sensitive', 'secret'] },
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
            subject: EPISODE_SUBJECT_SCHEMA,
            ...OWNER_AND_EVIDENCE_SCHEMA,
            title: { type: 'string' },
            summary: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            periodStart: { type: ['string', 'null'] },
            periodEnd: { type: ['string', 'null'] },
            sensitivity: { type: 'string', enum: ['low', 'personal', 'sensitive', 'secret'] },
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

function renderTranscriptLine(turn: MemoryConversationTurn, botSelfId: string): string {
  if (turn.role === 'ai') {
    return `[assistant speaker_id=${botSelfId} message_id=${turn.id} reply_to_message_id=${quoteAttr(turn.parentId)} attribution_source=assistant content=${quoteContent(turn.text)}]`;
  }
  const speakerId = turn.speakerId ?? 'unknown';
  return `[human target=${isTrustedTargetTurn(turn)} speaker_id=${speakerId} speaker_name=${quoteAttr(turn.speakerName)} message_id=${turn.id} attribution_source=${turn.attributionSource} content=${quoteContent(turn.text)}]`;
}

export function buildMemoryExtractionPrompt(
  turns: MemoryConversationTurn[],
  protocol: MemoryOutputProtocolId,
  target: MemoryExtractionTarget,
  address: Pick<MemoryAddress, 'channelType' | 'botSelfId'>,
): string {
  const transcript = turns.map((turn) => renderTranscriptLine(turn, address.botSelfId)).join('\n');
  const base = [
    `提取长期记忆候选。channel_type=${address.channelType}，目标 speaker_id=${target.speakerId} speaker_name=${quoteAttr(target.speakerName)}，botSelfId=${address.botSelfId}。`,
    'fact 的 subject 只允许 target_user、group_shared、assistant；episode 的 subject 只允许 target_user。',
    `target_user 的 canonical ownerSpeakerId=${target.speakerId}。证据只能引用该目标 speaker 的 human 行，且 attribution_source 必须是 additional_kwargs 或 direct_session。`,
    'group_shared 只允许在 channel_type=group 时输出，canonical ownerSpeakerId=group，sensitivity 必须是 low。证据只能引用 attribution_source=additional_kwargs 的 human 行；evidenceSpeakerIds 必须与所有证据行中明确声明的 speaker_id 集合完全一致。',
    `assistant 的 canonical ownerSpeakerId=${address.botSelfId}，sensitivity 必须是 low。证据只能引用 attribution_source=assistant 的 assistant 行，evidenceSpeakerIds 必须只包含 ${address.botSelfId}；assistant 行必须有可核验的 reply_to_message_id，运行时会使用其因果父请求的消息时 audience。`,
    '每条证据都必须使用真实 message_id。不要把 untrusted speaker_tag、unknown、其他角色的发言用于自动写入证据。',
    '长期记忆候选分为 fact 和 episode。fact kind 只能使用 identity、preference、trait、boundary、plan、relationship、response_policy；兴趣、爱好、喜欢/不喜欢统一用 preference。episode 用于将来值得回忆的用户相关事件。',
    '不要把群聊玩笑、外号、梗、第三方隐私、API key、token、password 写成长期记忆。',
    '可见范围由运行时依据可信会话地址和用户授权确定，输出中不得建议或覆盖可见范围。',
    'sensitivity 建议：普通偏好 low，个人信息 personal，隐私/健康/账号 sensitive，密钥 secret。',
    '每个 fact/episode 必须设置 subject、ownerSpeakerId、evidenceMessageIds、evidenceSpeakerIds，并遵守对应 subject 的 canonical owner 与可信证据规则。',
  ];

  base.push(
    `输出协议：${protocol}。`,
    '严格按提供的 JSON schema 输出 facts、episodes、drops。',
  );

  return [...base, '对话记录：', transcript].join('\n');
}

const FACT_KEYS = new Set([
  'subject',
  'ownerSpeakerId',
  'kind',
  'topicKey',
  'content',
  'keywords',
  'importance',
  'confidence',
  'sensitivity',
  'applicability',
  'evidence',
  'evidenceMessageIds',
  'evidenceSpeakerIds',
  'conflictHint',
  'validFrom',
  'validUntil',
  'expiresAt',
]);

const EPISODE_KEYS = new Set([
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
  'applicability',
  'evidence',
  'evidenceMessageIds',
  'evidenceSpeakerIds',
  'validFrom',
  'validUntil',
  'expiresAt',
]);

function invalid(path: string): never {
  throw new Error(`memory_extract_response_invalid:${path}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  return value as Record<string, unknown>;
}

function exactKeys(item: Record<string, unknown>, expected: ReadonlySet<string>, path: string): void {
  const keys = Object.keys(item);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) invalid(`${path}.keys`);
}

function text(item: Record<string, unknown>, key: string, path: string): string {
  const value = item[key];
  if (typeof value !== 'string' || !value.trim()) invalid(`${path}.${key}`);
  return value.trim();
}

function nullableText(item: Record<string, unknown>, key: string, path: string): string | null {
  const value = item[key];
  if (value === null) return null;
  if (typeof value !== 'string') invalid(`${path}.${key}`);
  return value.trim();
}

function strings(item: Record<string, unknown>, key: string, path: string): string[] {
  const value = item[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    invalid(`${path}.${key}`);
  }
  return uniqueKeywords(value as string[]);
}

function score(item: Record<string, unknown>, key: string, path: string): number {
  const value = item[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${path}.${key}`);
  }
  return value;
}

function subject(
  item: Record<string, unknown>,
  path: string,
  allowed: ReadonlySet<MemoryCandidateSubject>,
): MemoryCandidateSubject {
  const value = item.subject;
  if (
    typeof value !== 'string'
    || !SUBJECTS.has(value as MemoryCandidateSubject)
    || !allowed.has(value as MemoryCandidateSubject)
  ) {
    invalid(`${path}.subject`);
  }
  return value as MemoryCandidateSubject;
}

function sensitivity(item: Record<string, unknown>, path: string): MemorySensitivity {
  const value = item.sensitivity;
  if (typeof value !== 'string' || !SENSITIVITIES.has(value as MemorySensitivity)) {
    invalid(`${path}.sensitivity`);
  }
  return value as MemorySensitivity;
}

function parseFact(raw: unknown, index: number): ExtractedMemoryCandidate {
  const path = `facts[${index}]`;
  const item = record(raw, path);
  exactKeys(item, FACT_KEYS, path);
  const kind = parseProfileKind(item.kind);
  if (!kind) invalid(`${path}.kind`);
  return {
    candidateType: 'fact',
    subject: subject(item, path, FACT_SUBJECTS),
    ownerSpeakerId: text(item, 'ownerSpeakerId', path),
    kind,
    topicKey: text(item, 'topicKey', path),
    content: text(item, 'content', path),
    keywords: strings(item, 'keywords', path),
    importance: score(item, 'importance', path),
    confidence: score(item, 'confidence', path),
    sensitivity: sensitivity(item, path),
    applicability: nullableText(item, 'applicability', path),
    evidence: nullableText(item, 'evidence', path),
    evidenceMessageIds: strings(item, 'evidenceMessageIds', path),
    evidenceSpeakerIds: strings(item, 'evidenceSpeakerIds', path),
    conflictHint: nullableText(item, 'conflictHint', path),
    validFrom: nullableText(item, 'validFrom', path),
    validUntil: nullableText(item, 'validUntil', path),
    expiresAt: nullableText(item, 'expiresAt', path),
  };
}

function parseEpisode(raw: unknown, index: number): ExtractedMemoryCandidate {
  const path = `episodes[${index}]`;
  const item = record(raw, path);
  exactKeys(item, EPISODE_KEYS, path);
  return {
    candidateType: 'episode',
    subject: subject(item, path, EPISODE_SUBJECTS),
    ownerSpeakerId: text(item, 'ownerSpeakerId', path),
    title: text(item, 'title', path),
    summary: text(item, 'summary', path),
    keywords: strings(item, 'keywords', path),
    importance: score(item, 'importance', path),
    confidence: score(item, 'confidence', path),
    sensitivity: sensitivity(item, path),
    periodStart: nullableText(item, 'periodStart', path),
    periodEnd: nullableText(item, 'periodEnd', path),
    applicability: nullableText(item, 'applicability', path),
    evidence: nullableText(item, 'evidence', path),
    evidenceMessageIds: strings(item, 'evidenceMessageIds', path),
    evidenceSpeakerIds: strings(item, 'evidenceSpeakerIds', path),
    validFrom: nullableText(item, 'validFrom', path),
    validUntil: nullableText(item, 'validUntil', path),
    expiresAt: nullableText(item, 'expiresAt', path),
  };
}

export function parseMemoryExtractionJson(textValue: string): ExtractedMemoryCandidate[] {
  const parsed = record(JSON.parse(textValue.trim()) as unknown, 'root');
  exactKeys(parsed, new Set(['facts', 'episodes', 'drops']), 'root');
  if (!Array.isArray(parsed.facts) || parsed.facts.length > 8) invalid('facts');
  if (!Array.isArray(parsed.episodes) || parsed.episodes.length > 8) invalid('episodes');
  if (!Array.isArray(parsed.drops) || parsed.drops.length > 12) invalid('drops');
  const facts = parsed.facts.map(parseFact);
  const episodes = parsed.episodes.map(parseEpisode);
  const drops = parsed.drops.map((value, index): ExtractedMemoryCandidate => {
    if (typeof value !== 'string' || !value.trim()) invalid(`drops[${index}]`);
    return {
      candidateType: 'drop',
      subject: 'unknown',
      dropReason: value.trim(),
      keywords: [],
      importance: 0,
      confidence: 1,
      sensitivity: 'low',
    };
  });
  return [...facts, ...episodes, ...drops];
}
