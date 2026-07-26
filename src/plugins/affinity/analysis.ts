import type {
  AffinityAnalysisRoute,
  AffinityEffectTier,
  AffinityEventType,
} from '../../types/affinity.js';
import {
  serializeModelConfigDiagnostic,
  type ModelRuntimeClient,
} from '../model-config/index.js';
import type { AffinityEventAnalysis } from './rules.js';

export interface AnalyzeAffinityInput {
  text: string;
  recentContext?: string[];
  openThreads?: string[];
  relationSummary?: Record<string, unknown> | null;
  randomPending?: boolean;
}

const ROUTES = new Set<AffinityAnalysisRoute>([
  'ignore',
  'normal_chat',
  'affinity_flavor',
  'affinity_candidate',
  'random_event_reply',
  'group_event_progress',
  'boundary_risk',
]);

const EVENT_TYPES = new Set<AffinityEventType>([
  'none',
  'greeting_contextual',
  'offer_tea',
  'music_help',
  'care_subtle',
  'keep_promise',
  'boundary_respect',
  'light_tease',
  'contest_discussion',
  'computer_knowledge',
  'answer_random_prompt',
  'over_interaction',
  'pressure_or_spam',
  'promise_broken',
]);

const EFFECT_TIERS = new Set<AffinityEffectTier>(['ignore', 'flavor', 'mood', 'progress']);
const AFFINITY_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'route',
    'eventType',
    'effectTier',
    'category',
    'confidence',
    'risk',
    'evidence',
    'replyHint',
    'reasonCode',
  ],
  properties: {
    route: { type: 'string', enum: [...ROUTES] },
    eventType: { type: 'string', enum: [...EVENT_TYPES] },
    effectTier: { type: 'string', enum: [...EFFECT_TIERS] },
    category: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
    evidence: { type: ['string', 'null'] },
    replyHint: { type: ['string', 'null'] },
    reasonCode: { type: 'string' },
  },
} as const;

function trim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAnalysis(value: unknown): AffinityEventAnalysis | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const route = ROUTES.has(record.route as AffinityAnalysisRoute) ? record.route as AffinityAnalysisRoute : 'ignore';
  const eventType = EVENT_TYPES.has(record.eventType as AffinityEventType) ? record.eventType as AffinityEventType : 'none';
  const effectTier = EFFECT_TIERS.has(record.effectTier as AffinityEffectTier) ? record.effectTier as AffinityEffectTier : 'ignore';
  const confidence = Number(record.confidence);
  const riskValue = trim(record.risk);
  return {
    route,
    eventType,
    effectTier,
    category: trim(record.category) || eventType,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    evidence: trim(record.evidence) || null,
    replyHint: trim(record.replyHint) || null,
    risk: riskValue === 'low' || riskValue === 'medium' || riskValue === 'high' ? riskValue : 'none',
    reasonCode: trim(record.reasonCode) || eventType,
  };
}

function ignoredAnalysis(input: AnalyzeAffinityInput, reasonCode: string): AffinityEventAnalysis {
  const text = input.text.trim();
  return {
    route: 'ignore',
    eventType: 'none',
    effectTier: 'ignore',
    category: 'none',
    confidence: 0,
    evidence: text ? text.slice(0, 80) : null,
    replyHint: null,
    risk: 'none',
    reasonCode: text ? reasonCode : 'empty',
  };
}

function resolveActiveRandomThreadAnalysis(input: AnalyzeAffinityInput): AffinityEventAnalysis | null {
  const text = input.text.trim();
  const hasOpenThread = Boolean(input.randomPending || input.openThreads?.length);
  if (
    hasOpenThread &&
    /(前面|刚才|你说|你前面|你刚才|接一下|继续|补充|这个|这道|那道|我想了|我觉得|确实|应该|可以|不太对|懂了|明白了|回应一下)/u.test(text)
  ) {
    return {
      route: 'random_event_reply',
      eventType: 'answer_random_prompt',
      effectTier: 'progress',
      category: 'random_followup',
      confidence: 0.72,
      evidence: text.slice(0, 80),
      replyHint: 'continue_thread',
      risk: 'none',
      reasonCode: 'heuristic_random_followup',
    };
  }
  return null;
}

function resolveAnalysisUnavailable(input: AnalyzeAffinityInput, reasonCode: string): AffinityEventAnalysis {
  return resolveActiveRandomThreadAnalysis(input) ?? ignoredAnalysis(input, reasonCode);
}

function buildPrompt(input: AnalyzeAffinityInput): string {
  return [
    '请把用户消息路由到关系玩法事件。只输出 JSON，字段如下：',
    '{',
    '  "route": "ignore|normal_chat|affinity_flavor|affinity_candidate|random_event_reply|group_event_progress|boundary_risk",',
    '  "eventType": "none|greeting_contextual|offer_tea|music_help|care_subtle|keep_promise|boundary_respect|light_tease|contest_discussion|computer_knowledge|answer_random_prompt|over_interaction|pressure_or_spam|promise_broken",',
    '  "effectTier": "ignore|flavor|mood|progress",',
    '  "category": "短分类",',
    '  "confidence": 0到1,',
    '  "risk": "none|low|medium|high",',
    '  "evidence": "原文证据",',
    '  "replyHint": "给角色回复的短提示",',
    '  "reasonCode": "机器可读原因"',
    '}',
    '规则：模型不能决定分数，不能升阶。低确定性用 affinity_flavor 或 normal_chat。',
    `关系摘要: ${JSON.stringify(input.relationSummary ?? {})}`,
    `开放线索: ${JSON.stringify(input.openThreads ?? [])}`,
    `最近上下文: ${JSON.stringify(input.recentContext ?? [])}`,
    `是否回应随机事件: ${input.randomPending ? 'true' : 'false'}`,
    `用户消息: ${input.text}`,
  ].join('\n');
}

export async function analyzeAffinityEvent(
  input: AnalyzeAffinityInput,
  modelRuntime: ModelRuntimeClient,
  diagnostics: {
    onModelError?: (diagnostic: ReturnType<typeof serializeModelConfigDiagnostic>) => void;
  } = {},
): Promise<AffinityEventAnalysis> {
  try {
    const response = await modelRuntime.executeChat({
      workload: 'affinity.analysis',
      request: {
        temperature: 0,
        maxOutputTokens: 400,
        structuredOutput: {
          name: 'affinity_event_analysis',
          schema: AFFINITY_ANALYSIS_SCHEMA,
          strict: true,
        },
        messages: [
          {
            role: 'system',
            content: '你是 QQ 群关系玩法的事件分析器。按给定 schema 输出一个 JSON 对象。',
          },
          { role: 'user', content: buildPrompt(input) },
        ],
      },
    });
    const raw = response.text.trim();
    if (!raw) return resolveAnalysisUnavailable(input, 'analysis_model_empty_response');
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return resolveAnalysisUnavailable(input, 'analysis_model_invalid_response');
    }
    const parsed = normalizeAnalysis(decoded);
    return parsed ?? resolveAnalysisUnavailable(input, 'analysis_model_invalid_analysis');
  } catch (error) {
    diagnostics.onModelError?.(serializeModelConfigDiagnostic(error));
    return resolveAnalysisUnavailable(input, 'analysis_model_error');
  }
}
