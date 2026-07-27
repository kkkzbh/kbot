import { createHash } from 'node:crypto';
import type { MemoryAddress, MemoryOutputProtocolId } from '../../../types/memory.js';
import type { ModelRuntimeClient } from '../../model-config/index.js';
import type { ExtractedMemoryCandidate } from '../gates.js';
import {
  MEMORY_CANDIDATE_JSON_SCHEMA,
  buildMemoryExtractionPrompt,
  parseMemoryExtractionJson,
  type MemoryConversationTurn,
  type MemoryExtractionTarget,
} from './schemas.js';

export interface MemoryExtractInput {
  address: MemoryAddress;
  target: MemoryExtractionTarget;
  turns: MemoryConversationTurn[];
  modelRuntime: ModelRuntimeClient;
  maxFacts: number;
  maxEpisodes: number;
}

export interface MemoryExtractOutput {
  route: MemoryOutputProtocolId;
  ok: boolean;
  candidates: ExtractedMemoryCandidate[];
  drops: string[];
  rawTextHash: string | null;
  error: string | null;
}

export function isMemoryExtractWorkloadEnabled(
  modelRuntime: ModelRuntimeClient,
): boolean {
  return modelRuntime.resolve('memory.extract').target !== null;
}

export function resolveMemoryOutputProtocol(
  modelRuntime: ModelRuntimeClient,
): MemoryOutputProtocolId {
  const protocol = modelRuntime.resolve('memory.extract').target?.model
    .structuredOutputProtocol;
  if (protocol === 'native_responses_json_schema') {
    return 'native_responses_json_schema';
  }
  if (protocol === 'native_chat_json_schema') {
    return 'native_chat_json_schema';
  }
  return 'unsupported_protocol';
}

export async function extractMemoryCandidates(
  input: MemoryExtractInput,
): Promise<MemoryExtractOutput> {
  const route = resolveMemoryOutputProtocol(input.modelRuntime);
  if (!isMemoryExtractWorkloadEnabled(input.modelRuntime)) {
    return failed(route, 'memory_extract_disabled');
  }
  if (route === 'unsupported_protocol') {
    return failed(route, 'memory_extract_protocol_invalid');
  }

  const response = await input.modelRuntime.executeChat({
    workload: 'memory.extract',
    request: {
      temperature: 0.1,
      structuredOutput: {
        name: MEMORY_CANDIDATE_JSON_SCHEMA.name,
        strict: MEMORY_CANDIDATE_JSON_SCHEMA.strict,
        schema: MEMORY_CANDIDATE_JSON_SCHEMA.schema,
      },
      messages: [
        {
          role: 'system',
          content: '按 memory_extraction schema 提取长期记忆候选。',
        },
        {
          role: 'user',
          content: buildMemoryExtractionPrompt(
            input.turns,
            route,
            input.target,
            input.address,
          ),
        },
      ],
    },
  });
  const rawText = response.text.trim();

  try {
    const candidates = parseMemoryExtractionJson(rawText);
    const facts = candidates
      .filter((candidate) => candidate.candidateType === 'fact')
      .slice(0, input.maxFacts);
    const episodes = candidates
      .filter((candidate) => candidate.candidateType === 'episode')
      .slice(0, input.maxEpisodes);
    const dropCandidates = candidates.filter(
      (candidate) => candidate.candidateType === 'drop',
    );
    return {
      route,
      ok: true,
      candidates: [...facts, ...episodes, ...dropCandidates],
      drops: dropCandidates.map(() => 'provider_drop'),
      rawTextHash: rawText
        ? createHash('sha256').update(rawText).digest('hex')
        : null,
      error: null,
    };
  } catch (error) {
    return failed(route, 'memory_extract_response_invalid');
  }
}

function failed(
  route: MemoryOutputProtocolId,
  error: string,
): MemoryExtractOutput {
  return {
    route,
    ok: false,
    candidates: [],
    drops: [],
    rawTextHash: null,
    error,
  };
}
