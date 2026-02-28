/**
 * @deprecated 旧版 group-chat 核心逻辑。
 * 该文件仅保留用于回滚/参考，默认不启用。
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type {
  ChatPolicyDecision,
  ChatResponse,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIMessage,
} from '../types/chat.js';

export interface GroupChatConfig {
  enabledGroups: Set<string>;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxContextTurns: number;
  timeoutMs: number;
  userCooldownMs: number;
  groupQpsLimit: number;
  systemPrompt: string;
}

interface SystemPromptInput {
  systemPrompt?: string;
  systemPromptFile?: string;
}

interface ConversationRecord {
  messages: OpenAIMessage[];
  updatedAt: number;
}

export class MemoryConversationStore {
  private readonly store = new Map<string, ConversationRecord>();

  get(key: string, now: number, ttlMs: number): OpenAIMessage[] {
    const existing = this.store.get(key);
    if (!existing) return [];
    if (now - existing.updatedAt > ttlMs) {
      this.store.delete(key);
      return [];
    }
    return [...existing.messages];
  }

  set(key: string, messages: OpenAIMessage[], now: number): void {
    this.store.set(key, { messages, updatedAt: now });
  }
}

export class UserCooldownTracker {
  private readonly lastTriggerAt = new Map<string, number>();

  checkAndTouch(key: string, now: number, cooldownMs: number): { allowed: boolean; retryAfterMs?: number } {
    const last = this.lastTriggerAt.get(key);
    if (typeof last === 'number' && now - last < cooldownMs) {
      return { allowed: false, retryAfterMs: cooldownMs - (now - last) };
    }

    this.lastTriggerAt.set(key, now);
    return { allowed: true };
  }
}

export class GroupInFlightLimiter {
  private readonly inFlight = new Map<string, number>();

  tryAcquire(groupId: string, limit: number): boolean {
    const current = this.inFlight.get(groupId) ?? 0;
    if (current >= limit) {
      return false;
    }
    this.inFlight.set(groupId, current + 1);
    return true;
  }

  release(groupId: string): void {
    const current = this.inFlight.get(groupId);
    if (!current || current <= 1) {
      this.inFlight.delete(groupId);
      return;
    }
    this.inFlight.set(groupId, current - 1);
  }
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readSystemPromptFile(rawPath: string): string {
  const normalizedPath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
  const content = readFileSync(normalizedPath, 'utf8').trim();
  if (!content) {
    throw new Error(`System prompt file is empty: ${normalizedPath}`);
  }
  return content;
}

export function resolveSystemPrompt(input: SystemPromptInput): string {
  const promptFile = (input.systemPromptFile ?? process.env.CHAT_SYSTEM_PROMPT_FILE ?? '').trim();
  if (promptFile) {
    try {
      return readSystemPromptFile(promptFile);
    } catch (error) {
      throw new Error(`Failed to load system prompt file "${promptFile}": ${(error as Error).message}`);
    }
  }

  const inlinePrompt = (input.systemPrompt ?? process.env.CHAT_SYSTEM_PROMPT ?? '').trim();
  if (inlinePrompt) {
    return inlinePrompt;
  }

  return '你是群聊助手。回答要简洁、准确、中文优先，避免输出敏感凭证与危险操作指令。';
}

export function extractMentionText(content: string, selfId: string): string | null {
  if (!content) return null;

  const escapedId = escapeRegExp(selfId);
  const cqPattern = new RegExp(`\\[CQ:at,(?:qq|id)=${escapedId}\\]`, 'g');

  const matched = cqPattern.test(content);
  if (!matched) return null;

  const cleaned = content.replace(cqPattern, '').trim();
  return cleaned || null;
}

export function trimConversation(messages: OpenAIMessage[], maxContextTurns: number): OpenAIMessage[] {
  const maxMessages = Math.max(1, maxContextTurns) * 2;
  if (messages.length <= maxMessages) return messages;
  return messages.slice(messages.length - maxMessages);
}

export function decideChatPolicy(input: {
  groupId?: string;
  mentionText: string | null;
  enabledGroups: Set<string>;
  cooldownResult?: { allowed: boolean; retryAfterMs?: number };
  acquiredGroupSlot?: boolean;
}): ChatPolicyDecision {
  if (!input.groupId) {
    return { allowed: false, reason: 'group-not-enabled' };
  }

  if (!input.enabledGroups.has(input.groupId)) {
    return { allowed: false, reason: 'group-not-enabled' };
  }

  if (input.mentionText === null) {
    return { allowed: false, reason: 'not-mention-trigger' };
  }

  if (!input.mentionText.trim()) {
    return { allowed: false, reason: 'empty-content' };
  }

  if (input.cooldownResult && !input.cooldownResult.allowed) {
    return {
      allowed: false,
      reason: 'cooldown',
      retryAfterMs: input.cooldownResult.retryAfterMs,
    };
  }

  if (input.acquiredGroupSlot === false) {
    return { allowed: false, reason: 'group-busy' };
  }

  return { allowed: true, reason: 'ok' };
}

export function normalizeModelContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('')
      .trim();
  }

  return '';
}

export async function requestChatCompletion(
  config: GroupChatConfig,
  messages: OpenAIMessage[],
): Promise<ChatResponse> {
  const body: OpenAIChatCompletionRequest = {
    model: config.model,
    messages,
    temperature: 0.7,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`OpenAI-compatible API error (${response.status}): ${raw.slice(0, 400)}`);
    }

    const payload = (await response.json()) as OpenAIChatCompletionResponse;
    const first = payload.choices?.[0];
    const text = normalizeModelContent(first?.message?.content);
    if (!text) {
      throw new Error('Model returned empty content.');
    }

    return {
      text,
      finishReason: first?.finish_reason,
      usage: {
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens,
        totalTokens: payload.usage?.total_tokens,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildConversationKey(groupId: string, userId: string): string {
  return `${groupId}:${userId}`;
}
