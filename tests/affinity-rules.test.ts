import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInitialState,
  createRandomScheduleTimes,
  resolveAffinityEvent,
  selectRandomCount,
  type AffinityEventAnalysis,
  type AffinityStateInput,
} from '../src/plugins/affinity/rules.js';
import { analyzeAffinityEvent } from '../src/plugins/affinity/analysis.js';
import type { ModelRuntimeExecutionRequest } from '../src/plugins/model-config/index.js';
import { createTestModelRuntime } from './model-runtime-fixture.js';

function analysis(eventType: AffinityEventAnalysis['eventType'], overrides: Partial<AffinityEventAnalysis> = {}): AffinityEventAnalysis {
  return {
    route: 'affinity_candidate',
    eventType,
    effectTier: 'progress',
    category: eventType,
    confidence: 0.9,
    evidence: 'test',
    replyHint: null,
    risk: 'none',
    reasonCode: `test_${eventType}`,
    ...overrides,
  };
}

describe('affinity rules', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reduces positive gains when the current stage is near its soft cap', () => {
    const now = Date.now();
    const low = createInitialState(now);
    const high: AffinityStateInput = {
      ...low,
      trust: 18,
      familiarity: 20,
      comfort: 17,
    };

    const lowResult = resolveAffinityEvent(low, analysis('offer_tea'), now + 1000);
    const highResult = resolveAffinityEvent(high, analysis('offer_tea'), now + 1000);

    expect(highResult.delta.comfort ?? 0).toBeLessThan(lowResult.delta.comfort ?? 0);
    expect(highResult.delta.familiarity ?? 0).toBeLessThan(lowResult.delta.familiarity ?? 0);
  });

  it('amplifies negative changes at higher relationship stages', () => {
    const now = Date.now();
    const base = createInitialState(now);
    const special: AffinityStateInput = {
      ...base,
      trust: 92,
      familiarity: 90,
      comfort: 90,
      stage: 'special',
    };

    const lowResult = resolveAffinityEvent(base, analysis('pressure_or_spam', { route: 'boundary_risk' }), now + 1000);
    const highResult = resolveAffinityEvent(special, analysis('pressure_or_spam', { route: 'boundary_risk' }), now + 1000);

    expect(Math.abs(highResult.delta.comfort ?? 0)).toBeGreaterThan(Math.abs(lowResult.delta.comfort ?? 0));
    expect(highResult.delta.tension ?? 0).toBeGreaterThan(lowResult.delta.tension ?? 0);
  });

  it('selects random count from configured daily weights', () => {
    expect(selectRandomCount([0.25, 0.6, 0.1, 0.05], () => 0.0)).toBe(0);
    expect(selectRandomCount([0.25, 0.6, 0.1, 0.05], () => 0.3)).toBe(1);
    expect(selectRandomCount([0.25, 0.6, 0.1, 0.05], () => 0.9)).toBe(2);
    expect(selectRandomCount([0.25, 0.6, 0.1, 0.05], () => 0.98)).toBe(3);
  });

  it('creates proactive event times inside the configured Shanghai day window', () => {
    const now = Date.UTC(2026, 5, 17, 1, 0, 0); // 2026-06-17 09:00 Asia/Shanghai
    const times = createRandomScheduleTimes({
      now,
      count: 3,
      startHour: 8,
      endHour: 22,
      random: () => 0.5,
    });

    expect(times).toHaveLength(3);
    for (const time of times) {
      const hour = new Date(time + 8 * 60 * 60 * 1000).getUTCHours();
      expect(hour).toBeGreaterThanOrEqual(8);
      expect(hour).toBeLessThan(22);
    }
  });

  it('executes affinity analysis through the canonical inheritMain binding', async () => {
    const execute = vi.fn(async (_request: ModelRuntimeExecutionRequest) => ({
      text: JSON.stringify(analysis('offer_tea')),
    }));
    const { modelRuntime } = createTestModelRuntime({
      affinityMode: 'inheritMain',
      executor: { execute },
    });

    const result = await analyzeAffinityEvent({
      text: 'saki 我给你泡一杯红茶。',
      openThreads: [],
      randomPending: false,
      relationSummary: {},
    }, modelRuntime);

    expect(result.eventType).toBe('offer_tea');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      operation: 'chat',
      target: expect.objectContaining({
        canonicalModel: 'qqbot-primary/main-chat',
      }),
      payload: expect.objectContaining({
        structuredOutput: expect.objectContaining({
          name: 'affinity_event_analysis',
          strict: true,
        }),
      }),
    }));
  });

  it('routes natural replies to an active proactive random thread before greeting triggers', async () => {
    const result = await analyzeAffinityEvent({
      text: 'saki 我接一下你前面说的缩点：如果缩完还能成环，那这些点互相可达，确实应该在同一个 SCC 里。',
      openThreads: ['random:local_thread: SCC 缩点遗留讨论'],
      randomPending: true,
      relationSummary: {},
    }, createTestModelRuntime({
      executor: {
        async execute() {
          throw new Error('analysis unavailable');
        },
      },
    }).modelRuntime);

    expect(result).toEqual(expect.objectContaining({
      route: 'random_event_reply',
      eventType: 'answer_random_prompt',
      reasonCode: 'heuristic_random_followup',
    }));
  });

  it('does not apply relationship keyword heuristics when canonical analysis fails', async () => {
    const onModelError = vi.fn();
    const result = await analyzeAffinityEvent({
      text: 'saki 我给你泡一杯红茶，不急，等你想说再说。',
      openThreads: [],
      randomPending: false,
      relationSummary: {},
    }, createTestModelRuntime({
      executor: {
        async execute() {
          throw new Error('analysis unavailable');
        },
      },
    }).modelRuntime, { onModelError });

    expect(result).toEqual(expect.objectContaining({
      route: 'ignore',
      eventType: 'none',
      effectTier: 'ignore',
      reasonCode: 'analysis_model_error',
    }));
    expect(onModelError).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ModelConfigError',
      operation: 'execute',
      stage: 'transport',
      workload: 'affinity.analysis',
    }));
  });

  it('ignores invalid model output instead of applying relationship heuristics', async () => {
    const result = await analyzeAffinityEvent({
      text: 'saki 我给你泡一杯红茶。',
      openThreads: [],
      randomPending: false,
      relationSummary: {},
    }, createTestModelRuntime({
      executor: {
        async execute() {
          return { text: 'not json' };
        },
      },
    }).modelRuntime);

    expect(result).toEqual(expect.objectContaining({
      route: 'ignore',
      eventType: 'none',
      effectTier: 'ignore',
      reasonCode: 'analysis_model_invalid_response',
    }));
  });
});
