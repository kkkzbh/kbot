import { createHash } from 'node:crypto';

export type MemoryExtractLaneKey = `lane:${string}`;

export function createMemoryExtractLaneKey(
  subjectKey: string,
  contextKey: string,
): MemoryExtractLaneKey {
  const digest = createHash('sha256')
    .update(JSON.stringify([subjectKey, contextKey]))
    .digest('hex');
  return `lane:${digest}`;
}
