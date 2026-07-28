import { createHash } from 'node:crypto';
import type { MemoryAddress, MemoryLedgerItem } from '../../types/memory.js';
import { buildMemoryReferenceBlock } from './format.js';
import type { MemoryStore } from './store.js';

export interface MemoryRecallOptions {
  topK: number;
  promptBudgetTokens: number;
  now?: number;
}

export interface MemoryRecallResult {
  prompt: string | null;
  items: MemoryLedgerItem[];
}

export async function retrieveMemoryForContext(
  store: MemoryStore,
  address: MemoryAddress,
  query: string,
  options: MemoryRecallOptions,
): Promise<MemoryRecallResult> {
  const items = await store.listForContext(
    address,
    options.now ?? address.observedAt,
    query,
    Math.max(1, options.topK),
  );
  const prompt = buildMemoryReferenceBlock(items, options.promptBudgetTokens);
  if (items.length) {
    const requestKey = address.requestId?.trim()
      || `${address.observedAt}:${createHash('sha256').update(query).digest('hex')}`;
    await store.audit({
      idempotencyKey: `recall:${address.conversationId}:${requestKey}`,
      subjectKey: address.userKey,
      contextKey: address.contextKey,
      eventType: 'recall_selected',
      detail: {
        selected: items.map((item) => ({
          streamId: item.streamId,
          revision: item.revision,
          score: Number((item.lexicalScore ?? 0).toFixed(4)),
          reasonCode: 'lexical',
        })),
      },
      createdAt: address.observedAt,
    });
  }
  return { prompt, items };
}
