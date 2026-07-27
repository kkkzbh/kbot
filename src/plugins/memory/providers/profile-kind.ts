import type { MemoryFactKind } from '../gates.js';

export const PROFILE_KINDS = new Set<MemoryFactKind>([
  'identity',
  'preference',
  'trait',
  'boundary',
  'plan',
  'relationship',
  'response_policy',
]);

export function parseProfileKind(value: unknown): MemoryFactKind | null {
  return typeof value === 'string' && PROFILE_KINDS.has(value as MemoryFactKind)
    ? value as MemoryFactKind
    : null;
}
