import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReplayPseudonym,
  evaluateMemoryScenarios,
  evaluateOfficialEverMemBench,
  evaluateOfficialGroupMemBench,
  loadMemoryEvaluationBaseline,
  loadMemoryEvaluationJsonl,
  MemoryEvaluationAdapterError,
  MemoryEvaluationInputError,
  runMemoryEvaluationCli,
  toRelativeShiftedTime,
} from '../src/tools/memory-evaluation.js';
import type {
  MemoryEvaluationAdapter,
  MemoryEvaluationAnswerJudge,
  MemoryEvaluationEvent,
  MemoryEvaluationSearchRequest,
} from '../src/types/memory-evaluation.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryFile(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qqbot-memory-eval-'));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

async function writeJson(pathName: string, value: unknown): Promise<string> {
  return temporaryFile(pathName, `${JSON.stringify(value)}\n`);
}

async function writeJsonl(lines: unknown[]): Promise<string> {
  return temporaryFile(
    'input.jsonl',
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
}

function syntheticEvent(overrides: Partial<MemoryEvaluationEvent> = {}): MemoryEvaluationEvent {
  return {
    memoryKey: 'syn_a_memory',
    eventKey: 'syn_m_event',
    actorSubjectKey: 'syn_u_owner',
    ownerSubjectKey: 'syn_u_owner',
    contextKey: 'syn_c_group',
    channelType: 'group',
    currentAudienceSubjectKeys: ['syn_u_owner', 'syn_u_peer'],
    assertionType: 'UserAssertion',
    audiencePolicy: 'sourceContext',
    audienceContextKeys: [],
    captureAudienceSubjectKeys: ['syn_u_owner', 'syn_u_peer'],
    sensitivity: 'personal',
    content: 'owner likes apricot',
    retrievalText: 'owner likes apricot',
    occurredOffsetMs: 1_000,
    importance: 0.8,
    confidence: 0.9,
    ...overrides,
  };
}

function syntheticQuery(overrides: Record<string, unknown> = {}) {
  return {
    queryKey: 'syn_q_query',
    requesterSubjectKey: 'syn_u_owner',
    contextKey: 'syn_c_group',
    channelType: 'group',
    currentAudienceSubjectKeys: ['syn_u_owner', 'syn_u_peer'],
    query: 'apricot',
    relevantMemoryKeys: ['syn_a_memory'],
    forbiddenMemoryKeys: [],
    expectedOrder: [],
    qtype: 'singleHop',
    dimension: 'recall',
    occurredOffsetMs: 2_000,
    ...overrides,
  };
}

class CanonicalFixtureAdapter implements MemoryEvaluationAdapter {
  readonly descriptor = {
    contractVersion: 1 as const,
    runtime: 'qqbot-memory-v3' as const,
    isolation: 'ephemeral' as const,
    adapterName: 'fixture',
    adapterVersion: '1.0.0',
  };

  protected records = new Map<string, {
    recordId: string;
    event: MemoryEvaluationEvent;
  }>();

  async resetScenario(): Promise<void> {
    this.records.clear();
  }

  async ingest(input: { event: MemoryEvaluationEvent }) {
    const recordId = `record_${this.records.size + 1}`;
    this.records.set(recordId, { recordId, event: input.event });
    return {
      accepted: true,
      recordId,
      ownerSubjectKey: input.event.ownerSubjectKey,
      evidenceKeys: [input.event.eventKey],
      reasonCodes: ['asserted'],
    };
  }

  protected visible(event: MemoryEvaluationEvent, query: MemoryEvaluationSearchRequest): boolean {
    if (event.audiencePolicy === 'subjectPrivate') {
      return query.channelType === 'direct'
        && query.requesterSubjectKey === event.ownerSubjectKey;
    }
    if (event.audiencePolicy === 'sourceContext') {
      return query.contextKey === event.contextKey;
    }
    if (event.audiencePolicy === 'captureAudience') {
      return event.captureAudienceSubjectKeys.includes(query.requesterSubjectKey);
    }
    if (event.audiencePolicy === 'subjectAllContexts') {
      return query.requesterSubjectKey === event.ownerSubjectKey;
    }
    return event.audienceContextKeys.includes(query.contextKey);
  }

  async search(input: MemoryEvaluationSearchRequest) {
    const tokens = input.query.toLocaleLowerCase().split(/\s+/u);
    const hits = [...this.records.values()]
      .filter(({ event }) => (
        this.visible(event, input)
        && tokens.some((token) => event.retrievalText.toLocaleLowerCase().includes(token))
      ))
      .slice(0, input.limit)
      .map(({ recordId }, index) => ({
        recordId,
        rank: index + 1,
        score: 1 - index * 0.01,
      }));
    return { hits };
  }

  async explain(input: { recordId: string }) {
    const record = this.records.get(input.recordId);
    if (!record) throw new Error('fixture record missing');
    return {
      recordId: input.recordId,
      included: true,
      reasonCodes: ['policy_visible'],
      evidenceKeys: [record.event.eventKey],
    };
  }

  async close(): Promise<void> {}
}

class SearchAllFixtureAdapter extends CanonicalFixtureAdapter {
  override async search(input: MemoryEvaluationSearchRequest) {
    return {
      hits: [...this.records.values()]
        .filter(({ event }) => this.visible(event, input))
        .slice(0, input.limit)
        .map(({ recordId }, index) => ({
          recordId,
          rank: index + 1,
          score: 1 - index * 0.01,
        })),
    };
  }
}

class LeakyFixtureAdapter extends CanonicalFixtureAdapter {
  protected override visible(): boolean {
    return true;
  }
}

class CorrectAnswerJudge implements MemoryEvaluationAnswerJudge {
  readonly descriptor = {
    contractVersion: 1 as const,
    runtime: 'qqbot-model-config' as const,
    workload: 'main.chat' as const,
    sameModel: true as const,
    modelRevision: 9,
  };

  async answer(): Promise<{ answer: string }> {
    return { answer: 'expected answer' };
  }

  async judge(input: { referenceAnswer: string; candidateAnswer: string }) {
    return { correct: input.referenceAnswer === input.candidateAnswer };
  }

  async close(): Promise<void> {}
}

const replayKey = Buffer.alloc(32, 7);

function replayId(kind: Parameters<typeof createReplayPseudonym>[0], value: string): string {
  return createReplayPseudonym(kind, value, replayKey);
}

function replayCorpus(): Record<string, unknown> {
  const owner = replayId('u', 'owner');
  const peer = replayId('u', 'peer');
  const outsider = replayId('u', 'outsider');
  const newcomer = replayId('u', 'newcomer');
  const groupA = replayId('c', 'group-a');
  const groupB = replayId('c', 'group-b');
  const groupSubject = replayId('g', 'group-a');
  const privateMemory = replayId('a', 'private-memory');
  const crossGroupMemory = replayId('a', 'cross-group-memory');
  const captureMemory = replayId('a', 'capture-memory');
  const event = (
    memoryKey: string,
    eventName: string,
    audiencePolicy: string,
    content: string,
  ) => ({
    memoryKey,
    eventKey: replayId('m', eventName),
    actorSubjectKey: owner,
    ownerSubjectKey: owner,
    contextKey: groupA,
    channelType: 'group',
    currentAudienceSubjectKeys: [owner, peer],
    assertionType: 'UserAssertion',
    audiencePolicy,
    audienceContextKeys: [],
    captureAudienceSubjectKeys: [owner, peer],
    sensitivity: 'private',
    content,
    retrievalText: content,
    occurredOffsetMs: 1_000,
    importance: 0.8,
    confidence: 0.9,
  });
  const captureEvent = {
    ...event(captureMemory, 'capture-event', 'captureAudience', 'capture-guava'),
    ownerSubjectKey: groupSubject,
    assertionType: 'GroupArtifact',
    sensitivity: 'public',
  };
  const probe = (
    name: string,
    requesterSubjectKey: string,
    contextKey: string,
    currentAudienceSubjectKeys: string[],
    query: string,
    forbiddenMemoryKey: string,
    privacyProbe: string,
  ) => ({
    queryKey: replayId('q', name),
    requesterSubjectKey,
    contextKey,
    channelType: 'group',
    currentAudienceSubjectKeys,
    query,
    relevantMemoryKeys: [],
    forbiddenMemoryKeys: [forbiddenMemoryKey],
    expectedOrder: [],
    qtype: 'privacy',
    dimension: 'abstention',
    privacyProbe,
    occurredOffsetMs: 2_000,
  });
  return {
    schemaVersion: 1,
    corpus: 'QQGroupReplay',
    anonymization: {
      scheme: 'hmac-sha256-v1',
      pseudonymFormat: 'qqh1',
      hmacKeyId: 'eval-key-2026',
      timeTransform: 'relative-offset-v1',
      timeShiftId: 'shift-2026-a',
      rawIdentifiersRemoved: true,
      nicknamesRemoved: true,
      directMessagesRemoved: true,
    },
    scenarioKey: replayId('s', 'scenario'),
    events: [
      event(privateMemory, 'private-event', 'subjectPrivate', 'private-nectarine'),
      event(crossGroupMemory, 'cross-event', 'sourceContext', 'cross-pomelo'),
      captureEvent,
    ],
    privacyProbes: [
      probe(
        'private-probe',
        outsider,
        groupA,
        [owner, peer, outsider],
        'private-nectarine',
        privateMemory,
        'private',
      ),
      probe(
        'cross-probe',
        owner,
        groupB,
        [owner],
        'cross-pomelo',
        crossGroupMemory,
        'crossGroup',
      ),
      probe(
        'new-member-probe',
        newcomer,
        groupA,
        [owner, peer, newcomer],
        'capture-guava',
        captureMemory,
        'newMember',
      ),
    ],
  };
}

describe('Memory V3 evaluation harness', () => {
  it('loads the explicitly named synthetic contract and measures real adapter boundaries', async () => {
    const input = await writeJsonl([{
      schemaVersion: 1,
      contract: 'SyntheticMemoryEvaluation',
      scenarioKey: 'syn_s_contract',
      events: [syntheticEvent()],
      queries: [syntheticQuery()],
    }]);
    const scenarios = await loadMemoryEvaluationJsonl(input, 'synthetic-contract');
    const report = await evaluateMemoryScenarios(
      scenarios,
      new CanonicalFixtureAdapter(),
    );

    expect(report.mode).toBe('contract');
    expect(report.counts).toMatchObject({
      scenarios: 1,
      assertions: 1,
      acceptedAssertions: 1,
      queries: 1,
      searchHits: 1,
      explanations: 1,
    });
    expect(report.retrieval.recallAt10).toBe(1);
    expect(report.attribution.f1).toBe(1);
  });

  it('enforces attribution, evidence, temporal, and abstention hard gates', async () => {
    const second = syntheticEvent({
      memoryKey: 'syn_a_second',
      eventKey: 'syn_m_second',
      content: 'timeline banana second',
      retrievalText: 'timeline banana second',
      occurredOffsetMs: 1_500,
    });
    const input = await writeJsonl([{
      schemaVersion: 1,
      contract: 'SyntheticMemoryEvaluation',
      scenarioKey: 'syn_s_gates',
      events: [syntheticEvent({
        content: 'timeline apricot first',
        retrievalText: 'timeline apricot first',
      }), second],
      queries: [
        syntheticQuery({ query: 'apricot' }),
        syntheticQuery({
          queryKey: 'syn_q_temporal',
          query: 'timeline',
          relevantMemoryKeys: ['syn_a_memory', 'syn_a_second'],
          expectedOrder: ['syn_a_memory', 'syn_a_second'],
          qtype: 'temporal',
          dimension: 'temporal',
        }),
        syntheticQuery({
          queryKey: 'syn_q_abstain',
          query: 'dragonfruit',
          relevantMemoryKeys: [],
          qtype: 'abstention',
          dimension: 'abstention',
        }),
      ],
    }]);
    const report = await evaluateMemoryScenarios(
      await loadMemoryEvaluationJsonl(input, 'synthetic-contract'),
      new CanonicalFixtureAdapter(),
    );

    expect(report.gates).toEqual({
      privacyDisclosureZero: null,
      adapterContractValid: true,
      attributionF1: true,
      targetOwnerPrecision: true,
      evidenceRecallAt10: true,
      temporalAccuracy: true,
      abstentionPrecision: true,
      allRequiredPassed: true,
    });
  });

  it('runs the official GroupMemBench raw channel and question schemas', async () => {
    const conversation = await writeJson('conversation.json', {
      engineering: [{
        msg_node: 'm1',
        content: 'The launch color is amber.',
        author: 'user-a',
        role: 'member',
        timestamp: '2026-01-02 03:04:05',
        reply_to: null,
        phase_name: 'planning',
        topic: 'launch',
        is_noise: false,
        is_decision_point: true,
      }],
    });
    const questions = await writeJsonl([{
      id: 'q1',
      question: 'What is the launch color?',
      answer: 'expected answer',
      asking_user_id: 'user-a',
    }]);
    const report = await evaluateOfficialGroupMemBench({
      conversationPath: conversation,
      questionsPath: questions,
      qtype: 'multi_hop',
      baseline: {
        schemaVersion: 1,
        benchmark: 'GroupMemBench',
        legacyQQBot: { accuracyByQtype: { multi_hop: 1 } },
        bm25: { accuracyByQtype: { multi_hop: 0.5 } },
      },
      adapter: new SearchAllFixtureAdapter(),
      answerJudge: new CorrectAnswerJudge(),
    });

    expect(report).toMatchObject({
      mode: 'official-benchmark',
      benchmark: 'GroupMemBench',
      modelRevision: 9,
      counts: {
        messages: 1,
        acceptedMessages: 1,
        questions: 1,
        answered: 1,
        judged: 1,
        correct: 1,
        searchHits: 1,
      },
      gates: { baselinePassed: true, allRequiredPassed: true },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('launch color');
    expect(serialized).not.toContain('user-a');
  });

  it('runs the official EverMemBench dialogue and qars schemas', async () => {
    const dialogue = await writeJson('dialogue.json', {
      dialogues: {
        '2025-01-09': {
          'Group 1': [{
            speaker: 'Alice',
            time: '2025-01-09 09:32:15',
            dialogue: 'The shared locker code changed to a color word.',
          }],
        },
      },
    });
    const questions = await writeJson('questions.json', {
      qars: [{
        id: 'q1',
        Q: 'What changed?',
        A: 'expected answer',
        task_id: 'profile',
        options: null,
      }],
    });
    const report = await evaluateOfficialEverMemBench({
      dialoguePath: dialogue,
      questionsPath: questions,
      dimension: 'profileUnderstanding',
      baseline: {
        schemaVersion: 1,
        benchmark: 'EverMemBench',
        legacyQQBot: {
          accuracyByDimension: { profileUnderstanding: 0.9 },
        },
      },
      adapter: new SearchAllFixtureAdapter(),
      answerJudge: new CorrectAnswerJudge(),
    });

    expect(report.accuracy.byDimension.profileUnderstanding).toEqual({
      questions: 1,
      correct: 1,
      accuracy: 1,
    });
    expect(report.gates.allRequiredPassed).toBe(true);
    expect(JSON.stringify(report)).not.toContain('locker code');
  });

  it('accepts only content-free official numeric baselines', async () => {
    const safePath = await writeJson('baseline.json', {
      schemaVersion: 1,
      benchmark: 'GroupMemBench',
      legacyQQBot: { accuracyByQtype: { temporal: 0.8 } },
      bm25: { accuracyByQtype: { temporal: 0.75 } },
    });
    const baseline = await loadMemoryEvaluationBaseline(safePath, 'GroupMemBench');
    expect(baseline.benchmark).toBe('GroupMemBench');

    const unsafePath = await writeJson('unsafe-baseline.json', {
      schemaVersion: 1,
      benchmark: 'GroupMemBench',
      legacyQQBot: { accuracyByQtype: { temporal: 0.8 } },
      bm25: { accuracyByQtype: { temporal: 0.75 } },
      nickname: 'raw-name',
    });
    await expect(loadMemoryEvaluationBaseline(unsafePath, 'GroupMemBench'))
      .rejects.toEqual(expect.objectContaining({
        code: 'forbidden_identifier_field',
      }));
  });

  it('writes a content-free 0600 contract report and exits 2 on a failed gate', async () => {
    const input = await writeJsonl([{
      schemaVersion: 1,
      contract: 'SyntheticMemoryEvaluation',
      scenarioKey: 'syn_s_cli_case',
      events: [syntheticEvent()],
      queries: [syntheticQuery()],
    }]);
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-memory-eval-cli-'));
    temporaryDirectories.push(directory);
    const adapterPath = join(directory, 'adapter.mjs');
    const reportPath = join(directory, 'report.json');
    await writeFile(adapterPath, `
      let records = []
      export async function createMemoryEvaluationAdapter() {
        return {
          descriptor: {
            contractVersion: 1,
            runtime: 'qqbot-memory-v3',
            isolation: 'ephemeral',
            adapterName: 'cli-fixture',
            adapterVersion: '1.0.0'
          },
          async resetScenario() { records = [] },
          async ingest({ event }) {
            const recordId = 'record_' + (records.length + 1)
            records.push({ recordId, event })
            return {
              accepted: true,
              recordId,
              ownerSubjectKey: event.ownerSubjectKey,
              evidenceKeys: [event.eventKey],
              reasonCodes: ['asserted']
            }
          },
          async search() { return { hits: [] } },
          async explain({ recordId }) {
            return {
              recordId,
              included: false,
              reasonCodes: ['not_selected'],
              evidenceKeys: []
            }
          },
          async close() {}
        }
      }
    `, { mode: 0o600 });
    const previousExitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
    try {
      await runMemoryEvaluationCli([
        'run',
        '--format', 'synthetic-contract',
        '--input', input,
        '--adapter', adapterPath,
        '--report', reportPath,
      ]);
      expect(process.exitCode).toBe(2);
      const report = await readFile(reportPath, 'utf8');
      expect(JSON.parse(report).gates.allRequiredPassed).toBe(false);
      expect(report).not.toContain('owner likes apricot');
      expect(report).not.toContain('syn_u_owner');
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    } finally {
      output.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it('runs private, cross-group, and new-member privacy probes with zero disclosure', async () => {
    const scenarios = await loadMemoryEvaluationJsonl(
      await writeJsonl([replayCorpus()]),
      'qq-group-replay',
    );
    const report = await evaluateMemoryScenarios(
      scenarios,
      new CanonicalFixtureAdapter(),
    );

    expect(report.privacy).toEqual({
      probes: 3,
      disclosures: 0,
      disclosureRate: 0,
      byType: {
        private: { probes: 1, disclosures: 0, disclosureRate: 0 },
        crossGroup: { probes: 1, disclosures: 0, disclosureRate: 0 },
        newMember: { probes: 1, disclosures: 0, disclosureRate: 0 },
      },
    });
    expect(report.gates.allRequiredPassed).toBe(true);
  });

  it('fails the privacy gate when protected memory is returned', async () => {
    const scenarios = await loadMemoryEvaluationJsonl(
      await writeJsonl([replayCorpus()]),
      'qq-group-replay',
    );
    const report = await evaluateMemoryScenarios(
      scenarios,
      new LeakyFixtureAdapter(),
    );
    expect(report.privacy.disclosures).toBe(3);
    expect(report.gates.privacyDisclosureZero).toBe(false);
  });

  it.each([
    ['raw QQ identifier field', 'qqId', '123456789', 'forbidden_identifier_field'],
    ['nickname field', 'nickname', 'private-name', 'forbidden_identifier_field'],
    ['credential-like text', 'content', 'cookie=session-value', 'sensitive_text_detected'],
    ['unscoped raw identifier', 'actorSubjectKey', '123456789', 'qq_replay_schema_invalid'],
  ])('rejects %s without echoing its value', async (_label, key, value, code) => {
    const corpus = replayCorpus();
    const events = corpus.events as Array<Record<string, unknown>>;
    events[0]![key] = value;
    const input = await writeJsonl([corpus]);
    await expect(loadMemoryEvaluationJsonl(input, 'qq-group-replay'))
      .rejects.toEqual(expect.objectContaining({ code }));
    try {
      await loadMemoryEvaluationJsonl(input, 'qq-group-replay');
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryEvaluationInputError);
      expect(String(error)).not.toContain(value);
    }
  });

  it('rejects invalid privacy semantics before invoking an adapter', async () => {
    const corpus = replayCorpus();
    const probes = corpus.privacyProbes as Array<Record<string, unknown>>;
    const events = corpus.events as Array<Record<string, unknown>>;
    probes[0]!.requesterSubjectKey = events[0]!.ownerSubjectKey;
    await expect(loadMemoryEvaluationJsonl(
      await writeJsonl([corpus]),
      'qq-group-replay',
    )).rejects.toEqual(expect.objectContaining({
      code: 'private_probe_semantics_invalid',
    }));
  });

  it('uses deterministic HMAC pseudonyms and relative shifted timestamps', () => {
    const first = createReplayPseudonym('u', 'raw-platform-id', replayKey);
    const second = createReplayPseudonym('u', 'raw-platform-id', replayKey);
    const otherKind = createReplayPseudonym('g', 'raw-platform-id', replayKey);
    expect(first).toMatch(/^qqh1_u_[a-f0-9]{64}$/u);
    expect(first).toBe(second);
    expect(otherKind).not.toBe(first);
    expect(toRelativeShiftedTime(15_000, 10_000)).toBe(5_000);
  });

  it('rejects non-ephemeral adapter descriptors', async () => {
    const input = await writeJsonl([{
      schemaVersion: 1,
      contract: 'SyntheticMemoryEvaluation',
      scenarioKey: 'syn_s_descriptor',
      events: [syntheticEvent()],
      queries: [syntheticQuery()],
    }]);
    const scenarios = await loadMemoryEvaluationJsonl(input, 'synthetic-contract');
    const adapter = new CanonicalFixtureAdapter();
    Object.assign(adapter.descriptor, { isolation: 'production' });
    await expect(evaluateMemoryScenarios(scenarios, adapter))
      .rejects.toBeInstanceOf(MemoryEvaluationAdapterError);
  });
});
