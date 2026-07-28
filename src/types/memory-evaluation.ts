export type MemoryEvaluationSourceFormat =
  | 'synthetic-contract'
  | 'qq-group-replay';

export type MemoryOfficialBenchmark =
  | 'GroupMemBench'
  | 'EverMemBench';

export type GroupMemBenchQtype =
  | 'multi_hop'
  | 'knowledge_update'
  | 'temporal'
  | 'user_implicit'
  | 'term_ambiguity'
  | 'abstention';

export type EverMemBenchDimension =
  | 'recall'
  | 'memoryAwareness'
  | 'profileUnderstanding';

export type MemoryEvaluationAssertionType =
  | 'UserAssertion'
  | 'GroupArtifact'
  | 'AssistantCommitment'
  | 'Episode';

export type MemoryEvaluationAudiencePolicy =
  | 'subjectPrivate'
  | 'sourceContext'
  | 'captureAudience'
  | 'subjectAllContexts'
  | 'explicitContexts';

export type MemoryEvaluationSensitivity =
  | 'public'
  | 'personal'
  | 'private';

export type MemoryEvaluationPrivacyProbe =
  | 'private'
  | 'crossGroup'
  | 'newMember';

export type MemoryEvaluationDimension =
  | 'recall'
  | 'memoryAwareness'
  | 'profileUnderstanding'
  | 'temporal'
  | 'abstention';

export type MemoryEvaluationQtype =
  | 'singleHop'
  | 'multiHop'
  | 'temporal'
  | 'conflict'
  | 'groupArtifact'
  | 'speakerAttribution'
  | 'memoryAwareness'
  | 'profileUnderstanding'
  | 'abstention'
  | 'privacy';

export interface MemoryEvaluationEvent {
  memoryKey: string;
  eventKey: string;
  actorSubjectKey: string;
  ownerSubjectKey: string;
  contextKey: string;
  channelType: 'direct' | 'group';
  currentAudienceSubjectKeys: string[];
  assertionType: MemoryEvaluationAssertionType;
  audiencePolicy: MemoryEvaluationAudiencePolicy;
  audienceContextKeys: string[];
  captureAudienceSubjectKeys: string[];
  sensitivity: MemoryEvaluationSensitivity;
  content: string;
  retrievalText: string;
  occurredOffsetMs: number;
  importance: number;
  confidence: number;
}

export interface MemoryEvaluationQuery {
  queryKey: string;
  requesterSubjectKey: string;
  contextKey: string;
  channelType: 'direct' | 'group';
  currentAudienceSubjectKeys: string[];
  query: string;
  relevantMemoryKeys: string[];
  forbiddenMemoryKeys: string[];
  expectedOrder: string[];
  qtype: MemoryEvaluationQtype;
  dimension: MemoryEvaluationDimension;
  privacyProbe: MemoryEvaluationPrivacyProbe | null;
  occurredOffsetMs: number;
}

export interface MemoryEvaluationScenario {
  scenarioKey: string;
  sourceFormat: MemoryEvaluationSourceFormat;
  events: MemoryEvaluationEvent[];
  queries: MemoryEvaluationQuery[];
}

export interface MemoryEvaluationAdapterDescriptor {
  contractVersion: 1;
  runtime: 'qqbot-memory-v3';
  isolation: 'ephemeral';
  adapterName: string;
  adapterVersion: string;
}

export interface MemoryEvaluationIngestRequest {
  scenarioKey: string;
  event: MemoryEvaluationEvent;
}

export interface MemoryEvaluationIngestResult {
  accepted: boolean;
  recordId: string | null;
  ownerSubjectKey: string | null;
  evidenceKeys: string[];
  reasonCodes: string[];
}

export interface MemoryEvaluationSearchRequest {
  scenarioKey: string;
  queryKey: string;
  requesterSubjectKey: string;
  contextKey: string;
  channelType: 'direct' | 'group';
  currentAudienceSubjectKeys: string[];
  query: string;
  occurredOffsetMs: number;
  limit: 10;
}

export interface MemoryEvaluationSearchHit {
  recordId: string;
  rank: number;
  score: number;
}

export interface MemoryEvaluationSearchResult {
  hits: MemoryEvaluationSearchHit[];
}

export interface MemoryEvaluationExplainRequest {
  scenarioKey: string;
  queryKey: string;
  recordId: string;
}

export interface MemoryEvaluationExplainResult {
  recordId: string;
  included: boolean;
  reasonCodes: string[];
  evidenceKeys: string[];
}

export interface MemoryEvaluationAdapter {
  readonly descriptor: MemoryEvaluationAdapterDescriptor;
  resetScenario(input: { scenarioKey: string }): Promise<void>;
  ingest(input: MemoryEvaluationIngestRequest): Promise<MemoryEvaluationIngestResult>;
  search(input: MemoryEvaluationSearchRequest): Promise<MemoryEvaluationSearchResult>;
  explain(input: MemoryEvaluationExplainRequest): Promise<MemoryEvaluationExplainResult>;
  close(): Promise<void>;
}

export interface MemoryEvaluationAdapterModule {
  createMemoryEvaluationAdapter(): Promise<MemoryEvaluationAdapter>;
}

export interface MemoryEvaluationAnswerRequest {
  benchmark: MemoryOfficialBenchmark;
  question: string;
  passages: string[];
  options: Record<string, string> | null;
}

export interface MemoryEvaluationJudgeRequest {
  benchmark: MemoryOfficialBenchmark;
  question: string;
  referenceAnswer: string;
  candidateAnswer: string;
  options: Record<string, string> | null;
}

export interface MemoryEvaluationAnswerJudge {
  readonly descriptor: {
    contractVersion: 1;
    runtime: 'qqbot-model-config';
    workload: 'main.chat';
    sameModel: true;
    modelRevision: number;
  };
  answer(input: MemoryEvaluationAnswerRequest): Promise<{ answer: string }>;
  judge(input: MemoryEvaluationJudgeRequest): Promise<{ correct: boolean }>;
  close(): Promise<void>;
}

export interface MemoryEvaluationAnswerJudgeOptions {
  configPath: string;
  kekPath: string;
  runtimeRoot: string;
}

export interface MemoryEvaluationAnswerJudgeModule {
  createMemoryEvaluationAnswerJudge(
    options: MemoryEvaluationAnswerJudgeOptions,
  ): Promise<MemoryEvaluationAnswerJudge>;
}

export type MemoryEvaluationBaseline =
  | {
    schemaVersion: 1;
    benchmark: 'GroupMemBench';
    legacyQQBot: {
      accuracyByQtype: Partial<Record<GroupMemBenchQtype, number>>;
    };
    bm25: {
      accuracyByQtype: Partial<Record<GroupMemBenchQtype, number>>;
    };
  }
  | {
    schemaVersion: 1;
    benchmark: 'EverMemBench';
    legacyQQBot: {
      accuracyByDimension: Partial<Record<EverMemBenchDimension, number>>;
    };
  };

export interface MemoryContractEvaluationReport {
  schemaVersion: 1;
  mode: 'contract';
  sourceFormat: MemoryEvaluationSourceFormat;
  adapter: {
    runtime: 'qqbot-memory-v3';
    name: string;
    version: string;
  };
  counts: {
    scenarios: number;
    assertions: number;
    acceptedAssertions: number;
    queries: number;
    searchHits: number;
    explanations: number;
  };
  attribution: {
    precision: number;
    recall: number;
    f1: number;
    targetOwnerPrecision: number;
  };
  retrieval: {
    recallAt10: number;
    precisionAt10: number;
    hitRateAt10: number;
    evidenceRecallAt10: number;
    temporalAccuracy: number;
    abstentionPrecision: number;
    abstentionRecall: number;
    byQtype: Record<MemoryEvaluationQtype, {
      queries: number;
      successRate: number;
    }>;
  };
  privacy: {
    probes: number;
    disclosures: number;
    disclosureRate: number;
    byType: Record<MemoryEvaluationPrivacyProbe, {
      probes: number;
      disclosures: number;
      disclosureRate: number;
    }>;
  };
  gates: {
    privacyDisclosureZero: boolean | null;
    adapterContractValid: boolean;
    attributionF1: boolean | null;
    targetOwnerPrecision: boolean | null;
    evidenceRecallAt10: boolean | null;
    temporalAccuracy: boolean | null;
    abstentionPrecision: boolean | null;
    allRequiredPassed: boolean;
  };
}

export interface MemoryOfficialEvaluationReport {
  schemaVersion: 1;
  mode: 'official-benchmark';
  benchmark: MemoryOfficialBenchmark;
  modelRevision: number;
  counts: {
    messages: number;
    acceptedMessages: number;
    questions: number;
    answered: number;
    judged: number;
    correct: number;
    searchHits: number;
  };
  accuracy: {
    overall: number;
    byQtype: Partial<Record<GroupMemBenchQtype, {
      questions: number;
      correct: number;
      accuracy: number;
    }>>;
    byDimension: Partial<Record<EverMemBenchDimension, {
      questions: number;
      correct: number;
      accuracy: number;
    }>>;
  };
  gates: {
    baselinePassed: boolean;
    allRequiredPassed: boolean;
  };
}

export type MemoryEvaluationReport =
  | MemoryContractEvaluationReport
  | MemoryOfficialEvaluationReport;
