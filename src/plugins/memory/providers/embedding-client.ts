import type { ModelRuntimeClient } from '../../model-config/index.js';

export function isEmbeddingWorkloadEnabled(
  modelRuntime: ModelRuntimeClient,
): boolean {
  return modelRuntime.resolve('memory.embedding').target !== null;
}

export async function embedTexts(
  modelRuntime: ModelRuntimeClient,
  inputs: readonly string[],
): Promise<Array<number[] | null>> {
  if (inputs.length === 0) return [];
  if (!isEmbeddingWorkloadEnabled(modelRuntime)) {
    return inputs.map(() => null);
  }
  const response = await modelRuntime.executeEmbedding({
    workload: 'memory.embedding',
    request: { inputs },
  });
  return response.vectors.map((vector) => [...vector]);
}
