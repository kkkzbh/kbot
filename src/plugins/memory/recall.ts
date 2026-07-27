import { createHash } from 'node:crypto';
import type { MemoryAddress, MemoryLedgerItem } from '../../types/memory.js';
import { buildMemoryReferenceBlock, cosineSimilarity } from './format.js';
import type { MemoryEmbeddingIdentity, MemoryStore } from './store.js';

export interface MemoryRecallOptions {
  topK: number;
  promptBudgetTokens: number;
  embeddingIdentity: MemoryEmbeddingIdentity | null;
  now?: number;
  queryEmbedding?: number[] | null;
}

export interface MemoryRecallResult {
  prompt: string | null;
  items: MemoryLedgerItem[];
}

const MIN_SEMANTIC_SIMILARITY = 0.35;

function tokens(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().normalize('NFKC');
  const output = new Set<string>();
  for (const match of normalized.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    output.add(token);
    const characters = [...token];
    if (characters.some((character) => /\p{Script=Han}/u.test(character))) {
      for (const character of characters) output.add(character);
      for (let index = 0; index + 1 < characters.length; index += 1) {
        output.add(`${characters[index]}${characters[index + 1]}`);
      }
    }
  }
  return output;
}

function lexicalScore(query: Set<string>, document: Set<string>): number {
  if (!query.size || !document.size) return 0;
  let overlap = 0;
  for (const token of query) if (document.has(token)) overlap += 1;
  return overlap / Math.sqrt(query.size * document.size);
}

function rankItems(
  items: MemoryLedgerItem[],
  query: string,
  queryEmbedding: number[] | null,
  referenceNow: number,
): Array<{ item: MemoryLedgerItem; score: number; reason: string }> {
  const queryTokens = tokens(query);
  return items
    .map((item) => {
      const lexical = Math.max(
        lexicalScore(queryTokens, tokens(item.retrievalText)),
        item.ftsScore ?? 0,
      );
      const vector = queryEmbedding && item.embedding
        ? Math.max(0, cosineSimilarity(queryEmbedding, item.embedding))
        : 0;
      const hasRetrievalEvidence = lexical > 0
        || (
          queryEmbedding !== null
          && item.embedding !== null
          && vector >= MIN_SEMANTIC_SIMILARITY
        );
      const recencyDays = Math.max(0, (referenceNow - item.updatedAt) / 86_400_000);
      const recency = Math.exp(-recencyDays / 180);
      const score = lexical * 0.5
        + vector * 0.3
        + item.importance * 0.08
        + item.confidence * 0.08
        + recency * 0.04;
      return {
        item,
        score,
        hasRetrievalEvidence,
        reason: vector > lexical ? 'semantic' : lexical > 0 ? 'lexical' : 'quality',
      };
    })
    .filter((entry) => entry.hasRetrievalEvidence && entry.score >= 0.12)
    .sort((left, right) => right.score - left.score || left.item.streamId.localeCompare(right.item.streamId));
}

export async function retrieveMemoryForContext(
  store: MemoryStore,
  address: MemoryAddress,
  query: string,
  options: MemoryRecallOptions,
): Promise<MemoryRecallResult> {
  const referenceNow = options.now ?? address.observedAt;
  const available = await store.listForContext(
    address,
    options.embeddingIdentity,
    referenceNow,
    query,
  );
  const ranked = rankItems(
    available,
    query,
    options.queryEmbedding ?? null,
    referenceNow,
  )
    .slice(0, Math.max(1, options.topK));
  const items = ranked.map((entry) => entry.item);
  const prompt = buildMemoryReferenceBlock(items, options.promptBudgetTokens);
  if (prompt) {
    const requestKey = address.requestId?.trim()
      || `${address.observedAt}:${createHash('sha256').update(query).digest('hex')}`;
    await store.audit({
      idempotencyKey: `recall:${address.conversationId}:${requestKey}`,
      subjectKey: address.userKey,
      contextKey: address.contextKey,
      eventType: 'recall_selected',
      detail: {
        selected: ranked.map((entry) => ({
          streamId: entry.item.streamId,
          revision: entry.item.revision,
          score: Number(entry.score.toFixed(4)),
          reasonCode: entry.reason,
        })),
      },
      createdAt: address.observedAt,
    });
  }
  return { prompt, items };
}
