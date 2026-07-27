import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelConfigService } from '../src/plugins/model-config/index.js';
import { createReplayPseudonym } from '../src/tools/memory-evaluation.js';
import type {
  MemoryEvaluationAdapter,
  MemoryEvaluationAnswerJudge,
  MemoryEvaluationAnswerJudgeOptions,
} from '../src/types/memory-evaluation.js';
import { createValidModelConfigDraft } from './model-config/fixtures.js';

const temporaryDirectories: string[] = [];
const runtimePrefix = 'qqbot-memory-eval-runtime-';
const replayKey = Buffer.alloc(32, 19);

function replayId(
  kind: Parameters<typeof createReplayPseudonym>[0],
  value: string,
): string {
  return createReplayPseudonym(kind, value, replayKey);
}

function runtimeReplayCorpus(): Record<string, unknown> {
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
      hmacKeyId: 'runtime-eval-key',
      timeTransform: 'relative-offset-v1',
      timeShiftId: 'runtime-shift',
      rawIdentifiersRemoved: true,
      nicknamesRemoved: true,
      directMessagesRemoved: true,
    },
    scenarioKey: replayId('s', 'scenario'),
    events: [
      event(privateMemory, 'private-event', 'subjectPrivate', 'private-nectarine'),
      event(crossGroupMemory, 'cross-event', 'sourceContext', 'cross-pomelo'),
      {
        ...event(captureMemory, 'capture-event', 'captureAudience', 'capture-guava'),
        ownerSubjectKey: groupSubject,
        assertionType: 'GroupArtifact',
        sensitivity: 'public',
      },
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function listEvaluationRuntimeDirectories(): Promise<Set<string>> {
  return new Set(
    (await readdir('/var/tmp')).filter((entry) => entry.startsWith(runtimePrefix)),
  );
}

describe('built Memory V2 evaluation runtime', () => {
  it('executes the production-owned ephemeral SQLite adapter and cleans its database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-memory-eval-runtime-test-'));
    temporaryDirectories.push(directory);
    const outDir = join(directory, 'tools');
    const build = spawnSync(process.execPath, [
      resolve('scripts/build-memory-evaluation-tool.mjs'),
      '--out-dir',
      outDir,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(build.status, build.stderr).toBe(0);

    const inputPath = join(directory, 'input.jsonl');
    const reportPath = join(directory, 'report.json');
    await writeFile(inputPath, `${JSON.stringify({
      schemaVersion: 1,
      contract: 'SyntheticMemoryEvaluation',
      scenarioKey: 'syn_s_real_runtime',
      events: [
        {
          memoryKey: 'syn_a_runtime',
          eventKey: 'syn_m_runtime',
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
          content: 'runtime-evaluation-pineapple',
          retrievalText: 'runtime-evaluation-pineapple',
          occurredOffsetMs: 1_000,
          importance: 0.8,
          confidence: 1,
        },
        {
          memoryKey: 'syn_a_group_artifact',
          eventKey: 'syn_m_group_artifact',
          actorSubjectKey: 'syn_u_owner',
          ownerSubjectKey: 'syn_g_runtime',
          contextKey: 'syn_c_group',
          channelType: 'group',
          currentAudienceSubjectKeys: ['syn_u_owner', 'syn_u_peer'],
          assertionType: 'GroupArtifact',
          audiencePolicy: 'captureAudience',
          audienceContextKeys: [],
          captureAudienceSubjectKeys: ['syn_u_owner', 'syn_u_peer'],
          sensitivity: 'public',
          content: 'runtime-evaluation-orchid',
          retrievalText: 'runtime-evaluation-orchid',
          occurredOffsetMs: 1_100,
          importance: 0.9,
          confidence: 1,
        },
        {
          memoryKey: 'syn_a_assistant_commitment',
          eventKey: 'syn_m_assistant_commitment',
          actorSubjectKey: 'syn_u_owner',
          ownerSubjectKey: 'syn_b_runtime',
          contextKey: 'syn_c_direct',
          channelType: 'direct',
          currentAudienceSubjectKeys: ['syn_u_owner'],
          assertionType: 'AssistantCommitment',
          audiencePolicy: 'sourceContext',
          audienceContextKeys: [],
          captureAudienceSubjectKeys: ['syn_u_owner'],
          sensitivity: 'public',
          content: 'runtime-evaluation-cobalt',
          retrievalText: 'runtime-evaluation-cobalt',
          occurredOffsetMs: 1_200,
          importance: 0.9,
          confidence: 1,
        },
        {
          memoryKey: 'syn_a_timeline_old',
          eventKey: 'syn_m_timeline_old',
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
          content: 'timeline-marker old',
          retrievalText: 'timeline-marker old',
          occurredOffsetMs: 1_300,
          importance: 0.8,
          confidence: 1,
        },
        {
          memoryKey: 'syn_a_timeline_new',
          eventKey: 'syn_m_timeline_new',
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
          content: 'timeline-marker new',
          retrievalText: 'timeline-marker new',
          occurredOffsetMs: 1_400,
          importance: 0.8,
          confidence: 1,
        },
      ],
      queries: [
        {
          queryKey: 'syn_q_runtime',
          requesterSubjectKey: 'syn_u_owner',
          contextKey: 'syn_c_group',
          channelType: 'group',
          currentAudienceSubjectKeys: ['syn_u_owner', 'syn_u_peer'],
          query: 'pineapple',
          relevantMemoryKeys: ['syn_a_runtime'],
          forbiddenMemoryKeys: [],
          expectedOrder: [],
          qtype: 'singleHop',
          dimension: 'recall',
          occurredOffsetMs: 2_000,
        },
        {
          queryKey: 'syn_q_group_artifact',
          requesterSubjectKey: 'syn_u_owner',
          contextKey: 'syn_c_group',
          channelType: 'group',
          currentAudienceSubjectKeys: ['syn_u_owner', 'syn_u_peer'],
          query: 'orchid',
          relevantMemoryKeys: ['syn_a_group_artifact'],
          forbiddenMemoryKeys: [],
          expectedOrder: [],
          qtype: 'groupArtifact',
          dimension: 'recall',
          occurredOffsetMs: 2_100,
        },
        {
          queryKey: 'syn_q_assistant_commitment',
          requesterSubjectKey: 'syn_u_owner',
          contextKey: 'syn_c_direct',
          channelType: 'direct',
          currentAudienceSubjectKeys: ['syn_u_owner'],
          query: 'cobalt',
          relevantMemoryKeys: ['syn_a_assistant_commitment'],
          forbiddenMemoryKeys: [],
          expectedOrder: [],
          qtype: 'singleHop',
          dimension: 'recall',
          occurredOffsetMs: 2_200,
        },
        {
          queryKey: 'syn_q_temporal',
          requesterSubjectKey: 'syn_u_owner',
          contextKey: 'syn_c_group',
          channelType: 'group',
          currentAudienceSubjectKeys: ['syn_u_owner', 'syn_u_peer'],
          query: 'timeline-marker',
          relevantMemoryKeys: ['syn_a_timeline_new', 'syn_a_timeline_old'],
          forbiddenMemoryKeys: [],
          expectedOrder: ['syn_a_timeline_new', 'syn_a_timeline_old'],
          qtype: 'temporal',
          dimension: 'temporal',
          occurredOffsetMs: 2_300,
        },
        {
          queryKey: 'syn_q_abstention',
          requesterSubjectKey: 'syn_u_owner',
          contextKey: 'syn_c_group',
          channelType: 'group',
          currentAudienceSubjectKeys: ['syn_u_owner', 'syn_u_peer'],
          query: 'xylophonomicon',
          relevantMemoryKeys: [],
          forbiddenMemoryKeys: [],
          expectedOrder: [],
          qtype: 'abstention',
          dimension: 'abstention',
          occurredOffsetMs: 2_400,
        },
      ],
    })}\n`, { mode: 0o600 });

    const before = await listEvaluationRuntimeDirectories();
    const run = spawnSync(process.execPath, [
      join(outDir, 'memory-evaluation.mjs'),
      'run',
      '--format',
      'synthetic-contract',
      '--input',
      inputPath,
      '--adapter',
      join(outDir, 'memory-evaluation-adapter.mjs'),
      '--report',
      reportPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      counts: {
        acceptedAssertions: number;
        searchHits: number;
        explanations: number;
      };
      retrieval: {
        recallAt10: number;
        evidenceRecallAt10: number;
        temporalAccuracy: number;
        abstentionPrecision: number;
      };
      gates: {
        allRequiredPassed: boolean;
      };
    };
    expect(report.counts.acceptedAssertions).toBe(5);
    expect(report.counts.searchHits).toBeGreaterThanOrEqual(5);
    expect(report.counts.explanations).toBe(report.counts.searchHits);
    expect(report.retrieval.recallAt10).toBe(1);
    expect(report.retrieval.evidenceRecallAt10).toBe(1);
    expect(report.retrieval.temporalAccuracy).toBe(1);
    expect(report.retrieval.abstentionPrecision).toBe(1);
    expect(report.gates.allRequiredPassed).toBe(true);
    expect(run.status, run.stderr).toBe(0);
    expect(await listEvaluationRuntimeDirectories()).toEqual(before);

    const replayInputPath = join(directory, 'qq-group-replay.jsonl');
    const replayReportPath = join(directory, 'qq-group-replay-report.json');
    await writeFile(
      replayInputPath,
      `${JSON.stringify(runtimeReplayCorpus())}\n`,
      { mode: 0o600 },
    );
    const replayRun = spawnSync(process.execPath, [
      join(outDir, 'memory-evaluation.mjs'),
      'run',
      '--format',
      'qq-group-replay',
      '--input',
      replayInputPath,
      '--adapter',
      join(outDir, 'memory-evaluation-adapter.mjs'),
      '--report',
      replayReportPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const replayReport = JSON.parse(await readFile(replayReportPath, 'utf8')) as {
      privacy: {
        probes: number;
        disclosures: number;
        byType: Record<string, { probes: number; disclosures: number }>;
      };
      gates: {
        privacyDisclosureZero: boolean;
        allRequiredPassed: boolean;
      };
    };
    expect(replayReport.privacy).toMatchObject({
      probes: 3,
      disclosures: 0,
      byType: {
        private: { probes: 1, disclosures: 0 },
        crossGroup: { probes: 1, disclosures: 0 },
        newMember: { probes: 1, disclosures: 0 },
      },
    });
    expect(replayReport.gates).toEqual(expect.objectContaining({
      privacyDisclosureZero: true,
      allRequiredPassed: true,
    }));
    expect(replayRun.status, replayRun.stderr).toBe(0);
    expect(await listEvaluationRuntimeDirectories()).toEqual(before);

    const adapterModule = await import(
      `${pathToFileURL(join(outDir, 'memory-evaluation-adapter.mjs')).href}?test=1`
    ) as Record<string, unknown>;
    expect(adapterModule.createMemoryEvaluationAdapter).toBeTypeOf('function');
    expect(adapterModule.createMemoryEvaluationAnswerJudge).toBeTypeOf('function');

    let evaluationAdapter: MemoryEvaluationAdapter | null = null;
    try {
      evaluationAdapter = await (
        adapterModule.createMemoryEvaluationAdapter as (
          () => Promise<MemoryEvaluationAdapter>
        )
      )();
      await evaluationAdapter.resetScenario({ scenarioKey: 'syn_s_missing_capture' });
      await expect(evaluationAdapter.ingest({
        scenarioKey: 'syn_s_missing_capture',
        event: {
          memoryKey: 'syn_a_missing_capture',
          eventKey: 'syn_m_missing_capture',
          actorSubjectKey: 'syn_u_owner',
          ownerSubjectKey: 'syn_g_missing_capture',
          contextKey: 'syn_c_group',
          channelType: 'group',
          currentAudienceSubjectKeys: ['syn_u_owner'],
          assertionType: 'GroupArtifact',
          audiencePolicy: 'captureAudience',
          audienceContextKeys: [],
          captureAudienceSubjectKeys: [],
          sensitivity: 'public',
          content: 'missing-capture-must-fail',
          retrievalText: 'missing-capture-must-fail',
          occurredOffsetMs: 1_000,
          importance: 0.8,
          confidence: 1,
        },
      })).resolves.toMatchObject({
        accepted: false,
        reasonCodes: ['memory_group_artifact_evidence_untrusted'],
      });
    } finally {
      await evaluationAdapter?.close();
    }
    expect(await listEvaluationRuntimeDirectories()).toEqual(before);

    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        requests.push(body);
        const judged = Object.hasOwn(body, 'response_format');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: judged ? '{"correct":true}' : 'expected answer',
            },
          }],
        }));
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    let answerJudge: MemoryEvaluationAnswerJudge | null = null;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('mock model address missing');
      const draft = createValidModelConfigDraft();
      for (const connection of draft.connections) {
        connection.baseUrl = `http://127.0.0.1:${address.port}/v1`;
      }
      const configPath = join(directory, 'model-config.json');
      const kekPath = join(directory, 'model-config.kek');
      const initialize = new ModelConfigService({ configPath, kekPath });
      await initialize.createInitial({
        draft,
        apiKeys: {
          primary: 'test-primary-key',
          repairable: 'test-repairable-key',
        },
      });
      const apply = new ModelConfigService({ configPath, kekPath });
      await apply.loadAndApply(() => undefined);

      answerJudge = await (
        adapterModule.createMemoryEvaluationAnswerJudge as (
          options: MemoryEvaluationAnswerJudgeOptions,
        ) => Promise<MemoryEvaluationAnswerJudge>
      )({
        configPath,
        kekPath,
        runtimeRoot: directory,
      });
      expect(answerJudge.descriptor).toMatchObject({
        runtime: 'qqbot-model-config',
        workload: 'main.chat',
        sameModel: true,
        modelRevision: 1,
      });
      await expect(answerJudge.answer({
        benchmark: 'GroupMemBench',
        question: 'What is the expected answer?',
        passages: ['A passage.'],
        options: null,
      })).resolves.toEqual({ answer: 'expected answer' });
      await expect(answerJudge.judge({
        benchmark: 'GroupMemBench',
        question: 'What is the expected answer?',
        referenceAnswer: 'expected answer',
        candidateAnswer: 'expected answer',
        options: null,
      })).resolves.toEqual({ correct: true });
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.model === 'provider-chat-model')).toBe(true);
    } finally {
      await answerJudge?.close();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
  });
});
