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

export interface MemoryRecallAuditOptions {
  idempotencyKey: string;
  reasonCode: 'lexical' | 'recent';
  createdAt?: number;
}

export async function auditMemoryRecallSelection(
  store: MemoryStore,
  address: MemoryAddress,
  items: readonly MemoryLedgerItem[],
  options: MemoryRecallAuditOptions,
): Promise<void> {
  if (!items.length) return;
  await store.audit({
    idempotencyKey: options.idempotencyKey,
    subjectKey: address.userKey,
    contextKey: address.contextKey,
    eventType: 'recall_selected',
    detail: {
      selected: items.map((item) => ({
        streamId: item.streamId,
        revision: item.revision,
        score: Number((item.lexicalScore ?? 0).toFixed(4)),
        reasonCode: options.reasonCode,
      })),
    },
    createdAt: options.createdAt ?? address.observedAt,
  });
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
    await auditMemoryRecallSelection(store, address, items, {
      idempotencyKey: `recall:${address.conversationId}:${requestKey}`,
      reasonCode: query.trim() ? 'lexical' : 'recent',
      createdAt: address.observedAt,
    });
  }
  return { prompt, items };
}
