import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { MessageContent, MessageContentComplex } from '@langchain/core/messages';
import { buildNativeFeatureAssistantHistoryText } from '../shared/native-feature-history.js';
import { decodeStoredMessageJson } from '../shared/stored-message.js';
import { ChatReplyV1Parser } from './pipeline/chat-reply-v1.js';
import type { StructuredReply, StructuredReplyMessage } from './pipeline/types.js';

const gzipAsync = promisify(gzip);

export type StructuredReplyHistoryDatabaseLike = {
  get: (table: string, query: Record<string, unknown>, fields?: string[]) => Promise<Array<Record<string, unknown>>>;
  set: (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => Promise<unknown>;
  remove: (table: string, query: Record<string, unknown>) => Promise<unknown>;
};

export interface StructuredReplyHistoryMigrationResult {
  scanned: number;
  migrated: number;
  structuredRowsMigrated: number;
  legacyDirectHumanRowsTagged: number;
  submitReplyPlansMigrated: number;
  emptySubmitReplyPlanToolsRemoved: number;
  protocolViolationPromptsRemoved: number;
  failedToolCallErrorRowsRemoved: number;
  danglingToolCallTailRowsRemoved: number;
  completedToolTraceRowsMigrated: number;
  transientAdditionalKwargsRowsCleaned: number;
  invisibleMessageNamesCleared: number;
  nonAiToolCallsCleared: number;
  emptyAssistantRowsRemoved: number;
}

function normalizeLegacyStructuredReply(raw: unknown): StructuredReply | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  if (record.decision === 'no_reply') {
    return { decision: 'no_reply', outbound_messages: null };
  }
  if (record.decision !== 'reply') return null;

  const outbound = record.outbound_messages ?? record.messages;
  if (!Array.isArray(outbound)) return null;

  const messages: StructuredReplyMessage[] = [];
  for (const item of outbound) {
    if (!item || typeof item !== 'object') return null;
    const message = item as Record<string, unknown>;
    if (message.type === 'message' || message.type === 'structured_block' || message.type === 'voice' || message.type === 'meme') {
      if (typeof message.content !== 'string') return null;
      messages.push({
        type: message.type,
        content: message.content.trim(),
      } as StructuredReplyMessage);
      continue;
    }
    if (message.type === 'image') {
      if (typeof message.assetRef !== 'string' || typeof message.alt !== 'string') return null;
      messages.push({
        type: 'image',
        assetRef: message.assetRef.trim(),
        alt: message.alt.trim(),
      });
      continue;
    }
    if (typeof message.modality === 'string') {
      const migrated = normalizeLegacyMessageItem(message);
      if (!migrated) return null;
      messages.push(migrated);
      continue;
    }
    if (typeof message.kind === 'string') {
      const migrated = normalizeLegacyMessageItem(message);
      if (!migrated) return null;
      messages.push(migrated);
      continue;
    }
    return null;
  }

  return {
    decision: 'reply',
    outbound_messages: messages,
  };
}

function normalizeLegacyMessageItem(message: Record<string, unknown>): StructuredReplyMessage | null {
  const modality = message.modality ?? message.kind;
  if (modality === 'text' || modality === 'message') {
    const content = typeof message.content === 'string'
      ? message.content
      : renderLegacySegments(message.segments);
    if (!content) return null;
    return {
      type: 'message',
      content: content.trim(),
    };
  }

  if (modality === 'rich_text') {
    const segments = message.segments;
    if (!Array.isArray(segments)) return null;
    return {
      type: 'message',
      content: segments.map((segment) => renderLegacyRichTextSegment(segment)).join('').trim(),
    };
  }

  if (modality === 'voice') {
    const content = typeof message.content === 'string'
      ? message.content
      : renderLegacySegments(message.segments);
    if (!content) return null;
    return {
      type: 'voice',
      content: content.trim(),
    };
  }

  if (modality === 'meme' || modality === 'sticker') {
    if (typeof message.content !== 'string') return null;
    return {
      type: 'meme',
      content: message.content.trim(),
    };
  }

  if (modality === 'image') {
    const assetRef = typeof message.assetRef === 'string' ? message.assetRef.trim() : '';
    const alt = typeof message.alt === 'string'
      ? message.alt.trim()
      : typeof message.content === 'string'
        ? message.content.trim()
        : '';
    return {
      type: 'image',
      assetRef,
      alt,
    };
  }

  return null;
}

function renderLegacyRichTextSegment(segment: unknown): string {
  if (!segment || typeof segment !== 'object') return '';
  const record = segment as Record<string, unknown>;
  if (record.kind === 'text') {
    return typeof record.text === 'string'
      ? record.text
      : typeof record.content === 'string'
        ? record.content
        : '';
  }
  if (record.kind === 'mention') {
    const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
    return userId ? `@${userId}` : '';
  }
  if (record.kind === 'image') {
    const alt = typeof record.alt === 'string' ? record.alt.trim() : '';
    return alt ? `（发送图片：${alt}）` : '（发送图片）';
  }
  return '';
}

function renderLegacySegments(segments: unknown): string {
  if (!Array.isArray(segments)) return '';
  return segments.map((segment) => renderLegacyRichTextSegment(segment)).join('').trim();
}

function renderMigratedStructuredReplyHistory(reply: StructuredReply): string {
  if (reply.decision !== 'reply') return '';

  return (reply.outbound_messages ?? [])
    .map((message) => {
      if (message.type === 'message' || message.type === 'structured_block') {
        return message.content.trim();
      }
      if (message.type === 'voice') {
        const content = message.content.trim();
        return content ? `（发送语音：${content}）` : '';
      }
      if (message.type === 'image') {
        const alt = message.alt.trim();
        return alt ? `（发送图片：${alt}）` : '（发送图片）';
      }

      const content = message.content.trim();
      return content ? `（发送表情包：${content}）` : '（发送表情包）';
    })
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

function normalizeLegacyChatReplyV1History(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('CHAT_REPLY_V1 ')) return null;

  const withoutLegacyMentionHeader = trimmed
    .split(/\r\n?|\n/u)
    .filter((line) => !/^MENTIONS\s+/u.test(line.trim()))
    .join('\n');

  try {
    const parsed = new ChatReplyV1Parser().parse(withoutLegacyMentionHeader);
    return renderMigratedStructuredReplyHistory(parsed) || null;
  } catch {
    return null;
  }
}

const LEGACY_ASSISTANT_MENTION_HEADER_PATTERN = /^\[assistant_message\s+mentions=(\[[^\]\n]*\])\]\s*/u;

function parseLegacyMentionIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((item) => normalizeId(item)).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function normalizeLegacyAssistantMentionHeaderHistory(raw: string): string | null {
  let changed = false;
  const lines = raw.split(/\r\n?|\n/u).map((line) => {
    const match = LEGACY_ASSISTANT_MENTION_HEADER_PATTERN.exec(line);
    if (!match) return line;
    changed = true;

    const content = line.slice(match[0].length).trimStart();
    if (content) return content;

    const mentionIds = parseLegacyMentionIds(match[1] ?? '[]');
    return mentionIds.length > 0 ? `（提及用户：${mentionIds.join('、')}）` : '';
  });

  if (!changed) return null;
  return lines.join('\n').trim();
}

async function decodeStoredStringContent(content: unknown): Promise<string | null> {
  try {
    const storedContent = await decodeStoredMessageJson(content);
    return typeof storedContent === 'string' ? storedContent : null;
  } catch {
    return null;
  }
}

async function decodeStoredJsonObject(content: unknown): Promise<Record<string, unknown> | null> {
  try {
    const storedContent = await decodeStoredMessageJson(content);
    return storedContent && typeof storedContent === 'object' && !Array.isArray(storedContent)
      ? storedContent as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function normalizeNativeFeatureAssistantHistoryRow(
  row: Record<string, unknown>,
): Promise<string | null> {
  const additionalKwargs = await decodeStoredJsonObject(row.additional_kwargs_binary);
  const nativeFeature = additionalKwargs?.qqbot_native_feature;
  if (!nativeFeature || typeof nativeFeature !== 'object' || Array.isArray(nativeFeature)) return null;

  const metadata = nativeFeature as Record<string, unknown>;
  if (metadata.role !== 'result') return null;
  const summary = normalizeText(metadata.summary);
  if (!summary) return null;

  let storedContent: unknown;
  try {
    storedContent = await decodeStoredMessageJson(row.content);
  } catch {
    return null;
  }
  if (!Array.isArray(storedContent)) return null;
  if (!storedContent.every(
    (part): part is MessageContentComplex =>
      Boolean(part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string'),
  )) return null;

  return buildNativeFeatureAssistantHistoryText(summary, storedContent as MessageContent);
}

async function decodeStructuredReplyHistoryContent(content: unknown): Promise<string | null> {
  const storedContent = await decodeStoredStringContent(content);
  if (storedContent == null) return null;

  const normalizedChatReplyV1 = normalizeLegacyChatReplyV1History(storedContent);
  if (normalizedChatReplyV1) return normalizedChatReplyV1;

  const normalizedAssistantMentionHeader = normalizeLegacyAssistantMentionHeaderHistory(storedContent);
  if (normalizedAssistantMentionHeader) return normalizedAssistantMentionHeader;

  let structured: unknown;
  try {
    structured = JSON.parse(storedContent) as unknown;
  } catch {
    return null;
  }

  const reply = normalizeLegacyStructuredReply(structured);
  if (!reply) return null;

  const visibleHistory = renderMigratedStructuredReplyHistory(reply);
  return visibleHistory || null;
}

type LegacySubmitReplyPlanCall = {
  id?: unknown;
  name?: unknown;
  function?: {
    name?: unknown;
  };
  args?: {
    segments?: unknown;
  };
};

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function stripFormatControls(value: string): string {
  return value.replace(/\p{Cf}/gu, '').trim();
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseToolCalls(value: unknown): LegacySubmitReplyPlanCall[] {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value as LegacySubmitReplyPlanCall[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as LegacySubmitReplyPlanCall[] : [];
  } catch {
    return [];
  }
}

function hasStoredToolCallsColumnValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function isEmptyProviderToolCalls(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length < 1);
}

function getToolCallName(call: LegacySubmitReplyPlanCall): string {
  return normalizeText(call.name ?? call.function?.name);
}

function renderSubmitReplyPlanSegments(rawSegments: unknown): string {
  if (!Array.isArray(rawSegments)) return '';

  return rawSegments
    .map((segment) => {
      if (!segment || typeof segment !== 'object') return '';
      const record = segment as Record<string, unknown>;
      const kind = normalizeText(record.kind ?? record.type);
      const content = normalizeText(record.content);
      if (kind === 'text' || kind === 'message' || kind === 'structured_block') return content;
      if (kind === 'voice') return content ? `（发送语音：${content}）` : '';
      if (kind === 'sticker' || kind === 'meme') return content ? `（发送表情包：${content}）` : '（发送表情包）';
      if (kind === 'image') {
        const alt = normalizeText(record.alt ?? record.content);
        return alt ? `（发送图片：${alt}）` : '（发送图片）';
      }
      return content;
    })
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

async function isStoredContentEmpty(content: unknown): Promise<boolean> {
  const decoded = await decodeStoredStringContent(content);
  return decoded == null || decoded.trim() === '';
}

const LEGACY_REPLY_PLAN_VIOLATION_PREFIX = 'Protocol violation: reply-agent must finish by calling submit_reply_plan.';
const HISTORY_ROW_FIELDS = [
  'id',
  'conversationId',
  'parentId',
  'role',
  'name',
  'content',
  'tool_call_id',
  'tool_calls',
  'additional_kwargs_binary',
] as const;

const TRANSIENT_ADDITIONAL_KWARG_KEYS = [
  'qqbot_final_response_contract',
  'qqbot_final_response_schema',
  'qqbot_final_response_instruction',
  'qqbot_input_content_meta',
  'qqbot_attachment_refs',
  'qqbot_override_request_params',
  'qqbot_reply_mode',
  'qqbot_request_budget_policy',
  'overrideRequestParams',
  '__chatluna_provider_response_diagnostic_v1',
] as const;

const PROVIDER_REASONING_CONTENT_KEY = 'reasoning_content';
const PROVIDER_TOOL_CALLS_KEY = 'tool_calls';

const CONVERSATION_ROW_FIELDS = [
  'id',
  'bindingKey',
  'createdBy',
  'title',
  'latestMessageId',
  'legacyMeta',
] as const;

type LegacyDirectSpeaker = {
  speakerId: string;
  speakerName: string;
};

function parseLegacyMeta(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function resolveLegacyDirectSpeaker(conversation: Record<string, unknown> | undefined): LegacyDirectSpeaker | null {
  const bindingKey = normalizeText(conversation?.bindingKey);
  const createdBy = normalizeId(conversation?.createdBy);
  const directMatch = bindingKey.match(/^personal:legacy:legacy:direct:(\d+)$/u);
  if (!directMatch || !createdBy || directMatch[1] !== createdBy) return null;

  const legacyMeta = parseLegacyMeta(conversation?.legacyMeta);
  if (!legacyMeta || legacyMeta.visibility !== 'private') return null;
  const members = Array.isArray(legacyMeta.members) ? legacyMeta.members : [];
  if (members.length !== 1) return null;
  const member = members[0] as Record<string, unknown> | undefined;
  if (normalizeId(member?.userId) !== createdBy) return null;

  const titleName = stripFormatControls(normalizeText(conversation?.title).replace(/\s*的房间$/u, ''));
  return {
    speakerId: createdBy,
    speakerName: titleName || createdBy,
  };
}

function resolveLegacyDirectHumanSpeakerName(row: Record<string, unknown>, directSpeaker: LegacyDirectSpeaker): string {
  const rowName = stripFormatControls(normalizeText(row.name));
  return rowName || directSpeaker.speakerName;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLegacyDirectHumanText(text: string, directSpeaker: LegacyDirectSpeaker, speakerName: string): string {
  const normalized = text.trim();
  const legacyPrefixPattern = new RegExp(
    `^(?:${[speakerName, directSpeaker.speakerId]
      .map((candidate) => candidate.trim())
      .filter(Boolean)
      .map(escapeRegExp)
      .join('|')}),\\s*\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}:\\s*([\\s\\S]+)$`,
    'u',
  );
  const legacyPrefixMatch = legacyPrefixPattern.exec(normalized);
  return (legacyPrefixMatch?.[1] ?? normalized).trim();
}

function formatSpeakerTag(speakerId: string, speakerName: string): string {
  return `[speaker_id=${speakerId} speaker_name=${JSON.stringify(speakerName)}]`;
}

function buildRowsByParent(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
  const rowsByParent = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const parentId = normalizeId(row.parentId);
    const bucket = rowsByParent.get(parentId) ?? [];
    bucket.push(row);
    rowsByParent.set(parentId, bucket);
  }
  return rowsByParent;
}

function buildRowsById(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const rowsById = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = normalizeId(row.id);
    if (id) rowsById.set(id, row);
  }
  return rowsById;
}

function resolveNearestKeptParentId(
  row: Record<string, unknown>,
  rowsById: Map<string, Record<string, unknown>>,
  removedIds: Set<string>,
): string | null {
  let parentId = normalizeId(row.parentId) || null;
  const seen = new Set<string>();
  while (parentId && removedIds.has(parentId) && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = rowsById.get(parentId);
    parentId = parent ? normalizeId(parent.parentId) || null : null;
  }
  return parentId;
}

async function isGenericChatLunaToolError(content: unknown): Promise<boolean> {
  const decoded = await decodeStoredStringContent(content);
  return Boolean(
    decoded?.includes('使用 ChatLuna 时出现错误') &&
    decoded.includes('错误码为 103'),
  );
}

async function renderLegacyToolActionHistory(row: Record<string, unknown>): Promise<string | null> {
  if (normalizeText(row.name) !== 'send_sticker') return null;
  const decoded = await decodeStoredStringContent(row.content);
  const match = decoded?.match(/^已发送表情包:\s*(.+)$/u);
  const sticker = normalizeText(match?.[1]);
  return sticker ? `（发送表情包：${sticker}）` : '（发送表情包）';
}

export async function migrateStructuredReplyHistoryRows(
  database: StructuredReplyHistoryDatabaseLike,
): Promise<StructuredReplyHistoryMigrationResult> {
  const aiRows = await database.get(
    'chatluna_message',
    { role: 'ai' },
    ['id', 'role', 'content', 'additional_kwargs_binary'],
  );
  let structuredRowsMigrated = 0;

  for (const row of aiRows) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;

    const visibleHistory = await decodeStructuredReplyHistoryContent(row.content);
    if (!visibleHistory) continue;

    await database.set('chatluna_message', { id }, {
      content: await gzipAsync(JSON.stringify(visibleHistory)),
    });
    structuredRowsMigrated += 1;
  }

  for (const row of aiRows) {
    const id = normalizeId(row.id);
    if (!id) continue;

    const semanticHistory = await normalizeNativeFeatureAssistantHistoryRow(row);
    if (!semanticHistory) continue;

    await database.set('chatluna_message', { id }, {
      content: await gzipAsync(JSON.stringify(semanticHistory)),
    });
    structuredRowsMigrated += 1;
  }

  const allRows = await database.get('chatluna_message', {}, [...HISTORY_ROW_FIELDS]);
  const conversations = await database.get('chatluna_conversation', {}, [...CONVERSATION_ROW_FIELDS]);
  const conversationsById = buildRowsById(conversations);
  const rowsByParent = buildRowsByParent(allRows);

  let legacyDirectHumanRowsTagged = 0;
  let submitReplyPlansMigrated = 0;
  let emptySubmitReplyPlanToolsRemoved = 0;
  let protocolViolationPromptsRemoved = 0;
  let failedToolCallErrorRowsRemoved = 0;
  let danglingToolCallTailRowsRemoved = 0;
  let completedToolTraceRowsMigrated = 0;
  let transientAdditionalKwargsRowsCleaned = 0;
  let invisibleMessageNamesCleared = 0;
  let nonAiToolCallsCleared = 0;
  let emptyAssistantRowsRemoved = 0;

  for (const row of allRows) {
    const id = normalizeId(row.id);
    if (!id) continue;

    const name = normalizeText(row.name);
    if (name && !stripFormatControls(name)) {
      await database.set('chatluna_message', { id }, { name: null });
      invisibleMessageNamesCleared += 1;
    }

    if (row.role !== 'ai' && hasStoredToolCallsColumnValue(row.tool_calls)) {
      await database.set('chatluna_message', { id }, { tool_calls: null });
      nonAiToolCallsCleared += 1;
    }

    const additionalKwargs = await decodeStoredJsonObject(row.additional_kwargs_binary);
    if (!additionalKwargs) continue;

    let changed = false;
    const cleanedAdditionalKwargs = { ...additionalKwargs };
    for (const key of TRANSIENT_ADDITIONAL_KWARG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(cleanedAdditionalKwargs, key)) {
        delete cleanedAdditionalKwargs[key];
        changed = true;
      }
    }
    if (
      row.role === 'ai' &&
      parseToolCalls(row.tool_calls).length < 1 &&
      Object.prototype.hasOwnProperty.call(cleanedAdditionalKwargs, PROVIDER_REASONING_CONTENT_KEY)
    ) {
      delete cleanedAdditionalKwargs[PROVIDER_REASONING_CONTENT_KEY];
      changed = true;
    }
    if (
      Object.prototype.hasOwnProperty.call(cleanedAdditionalKwargs, PROVIDER_TOOL_CALLS_KEY) &&
      isEmptyProviderToolCalls(cleanedAdditionalKwargs[PROVIDER_TOOL_CALLS_KEY])
    ) {
      delete cleanedAdditionalKwargs[PROVIDER_TOOL_CALLS_KEY];
      changed = true;
    }
    if (!changed) continue;

    await database.set('chatluna_message', { id }, {
      additional_kwargs_binary: Object.keys(cleanedAdditionalKwargs).length > 0
        ? await gzipAsync(JSON.stringify(cleanedAdditionalKwargs))
        : null,
    });
    transientAdditionalKwargsRowsCleaned += 1;
  }

  for (const row of allRows) {
    const id = normalizeId(row.id);
    if (!id || row.role !== 'human') continue;
    const conversationId = normalizeId(row.conversationId);
    const directSpeaker = resolveLegacyDirectSpeaker(conversationsById.get(conversationId));
    if (!directSpeaker) continue;

    const content = await decodeStoredStringContent(row.content);
    if (!content || content.trim().startsWith('[speaker_id=')) continue;

    const speakerName = resolveLegacyDirectHumanSpeakerName(row, directSpeaker);
    const visibleText = normalizeLegacyDirectHumanText(content, directSpeaker, speakerName);
    if (!visibleText) continue;

    await database.set('chatluna_message', { id }, {
      content: await gzipAsync(JSON.stringify(`${formatSpeakerTag(directSpeaker.speakerId, speakerName)} ${visibleText}`)),
    });
    legacyDirectHumanRowsTagged += 1;
  }

  for (const row of allRows) {
    const id = normalizeId(row.id);
    if (!id || row.role !== 'ai') continue;
    if (!(await isStoredContentEmpty(row.content))) continue;

    const toolCalls = parseToolCalls(row.tool_calls);
    if (toolCalls.length !== 1 || getToolCallName(toolCalls[0]) !== 'submit_reply_plan') continue;

    const visibleHistory = renderSubmitReplyPlanSegments(toolCalls[0].args?.segments);
    if (!visibleHistory) continue;

    const children = rowsByParent.get(id) ?? [];
    const emptyToolRows = [];
    for (const child of children) {
      if (child.role !== 'tool' || child.name !== 'submit_reply_plan') continue;
      const toolCallId = normalizeId(child.tool_call_id);
      if (toolCallId && toolCallId !== normalizeId(toolCalls[0].id)) continue;
      if (!(await isStoredContentEmpty(child.content))) continue;
      emptyToolRows.push(child);
    }
    if (!emptyToolRows.length) continue;

    await database.set('chatluna_message', { id }, {
      content: await gzipAsync(JSON.stringify(visibleHistory)),
      tool_calls: [],
    });
    submitReplyPlansMigrated += 1;

    for (const toolRow of emptyToolRows) {
      const toolId = normalizeId(toolRow.id);
      if (!toolId) continue;

      for (const grandchild of rowsByParent.get(toolId) ?? []) {
        const grandchildId = normalizeId(grandchild.id);
        if (grandchildId) {
          await database.set('chatluna_message', { id: grandchildId }, { parentId: id });
        }
      }
      await database.set('chatluna_conversation', { latestMessageId: toolId }, { latestMessageId: id });
      await database.remove('chatluna_message', { id: toolId });
      emptySubmitReplyPlanToolsRemoved += 1;
    }
  }

  for (const row of allRows) {
    const id = normalizeId(row.id);
    if (!id || row.role !== 'human' || normalizeId(row.name)) continue;

    const content = await decodeStoredStringContent(row.content);
    if (!content?.startsWith(LEGACY_REPLY_PLAN_VIOLATION_PREFIX)) continue;

    const parentId = normalizeId(row.parentId) || null;
    for (const child of rowsByParent.get(id) ?? []) {
      const childId = normalizeId(child.id);
      if (childId) {
        await database.set('chatluna_message', { id: childId }, { parentId });
      }
    }
    await database.set('chatluna_conversation', { latestMessageId: id }, { latestMessageId: parentId });
    await database.remove('chatluna_message', { id });
    protocolViolationPromptsRemoved += 1;
  }

  const postProtocolRows = await database.get('chatluna_message', {}, [...HISTORY_ROW_FIELDS]);
  const postProtocolRowsByParent = buildRowsByParent(postProtocolRows);

  for (const row of postProtocolRows) {
    const id = normalizeId(row.id);
    if (!id || row.role !== 'ai') continue;
    if (!(await isStoredContentEmpty(row.content))) continue;

    const toolCalls = parseToolCalls(row.tool_calls);
    if (toolCalls.length !== 1) continue;

    const toolCallId = normalizeId(toolCalls[0].id);
    const toolCallName = getToolCallName(toolCalls[0]);
    if (!toolCallId || !toolCallName) continue;

    const children = postProtocolRowsByParent.get(id) ?? [];
    if (children.length !== 1) continue;

    const toolRow = children[0];
    const toolId = normalizeId(toolRow.id);
    if (!toolId || toolRow.role !== 'tool') continue;
    if (normalizeId(toolRow.tool_call_id) !== toolCallId) continue;
    if (normalizeText(toolRow.name) !== toolCallName) continue;
    if (!(await isGenericChatLunaToolError(toolRow.content))) continue;

    const parentId = normalizeId(row.parentId) || null;
    for (const grandchild of postProtocolRowsByParent.get(toolId) ?? []) {
      const grandchildId = normalizeId(grandchild.id);
      if (grandchildId) {
        await database.set('chatluna_message', { id: grandchildId }, { parentId });
      }
    }
    await database.set('chatluna_conversation', { latestMessageId: toolId }, { latestMessageId: parentId });
    await database.set('chatluna_conversation', { latestMessageId: id }, { latestMessageId: parentId });
    await database.remove('chatluna_message', { id: toolId });
    await database.remove('chatluna_message', { id });
    failedToolCallErrorRowsRemoved += 2;
  }

  for (;;) {
    const postFailedToolRows = await database.get('chatluna_message', {}, [...HISTORY_ROW_FIELDS]);
    const postFailedToolRowsByParent = buildRowsByParent(postFailedToolRows);
    const postFailedToolConversations = await database.get('chatluna_conversation', {}, [...CONVERSATION_ROW_FIELDS]);
    const latestMessageIds = new Set(
      postFailedToolConversations
        .map((conversation) => normalizeId(conversation.latestMessageId))
        .filter(Boolean),
    );
    let passRemoved = 0;

    for (const row of postFailedToolRows) {
      const id = normalizeId(row.id);
      if (!id || row.role !== 'ai') continue;
      if (!(await isStoredContentEmpty(row.content))) continue;

      const toolCalls = parseToolCalls(row.tool_calls);
      if (toolCalls.length !== 1) continue;

      const toolCallId = normalizeId(toolCalls[0].id);
      const toolCallName = getToolCallName(toolCalls[0]);
      if (!toolCallId || !toolCallName) continue;

      const children = postFailedToolRowsByParent.get(id) ?? [];
      if (children.length !== 1) continue;

      const toolRow = children[0];
      const toolId = normalizeId(toolRow.id);
      if (!toolId || toolRow.role !== 'tool') continue;
      if (!latestMessageIds.has(toolId)) continue;
      if (normalizeId(toolRow.tool_call_id) !== toolCallId) continue;
      if (normalizeText(toolRow.name) !== toolCallName) continue;
      if ((postFailedToolRowsByParent.get(toolId) ?? []).length > 0) continue;

      const parentId = normalizeId(row.parentId) || null;
      await database.set('chatluna_conversation', { latestMessageId: toolId }, { latestMessageId: parentId });
      await database.remove('chatluna_message', { id: toolId });
      await database.remove('chatluna_message', { id });
      passRemoved += 2;
    }

    if (passRemoved === 0) break;
    danglingToolCallTailRowsRemoved += passRemoved;
  }

  for (;;) {
    const completedToolRows = await database.get('chatluna_message', {}, [...HISTORY_ROW_FIELDS]);
    const completedToolRowsByParent = buildRowsByParent(completedToolRows);
    let passMigrated = 0;

    for (const row of completedToolRows) {
      const id = normalizeId(row.id);
      if (!id || row.role !== 'ai') continue;
      if (!(await isStoredContentEmpty(row.content))) continue;

      const toolCalls = parseToolCalls(row.tool_calls);
      if (toolCalls.length !== 1) continue;

      const toolCallId = normalizeId(toolCalls[0].id);
      const toolCallName = getToolCallName(toolCalls[0]);
      if (!toolCallId || !toolCallName || toolCallName === 'submit_reply_plan') continue;

      const children = completedToolRowsByParent.get(id) ?? [];
      if (children.length !== 1) continue;

      const toolRow = children[0];
      const toolId = normalizeId(toolRow.id);
      if (!toolId || toolRow.role !== 'tool') continue;
      if (normalizeId(toolRow.tool_call_id) !== toolCallId) continue;
      if (normalizeText(toolRow.name) !== toolCallName) continue;

      const grandchildren = completedToolRowsByParent.get(toolId) ?? [];
      if (!grandchildren.length) continue;

      const visibleActionHistory = await renderLegacyToolActionHistory(toolRow);
      if (visibleActionHistory) {
        await database.set('chatluna_message', { id }, {
          content: await gzipAsync(JSON.stringify(visibleActionHistory)),
          tool_calls: [],
        });
        for (const grandchild of grandchildren) {
          const grandchildId = normalizeId(grandchild.id);
          if (grandchildId) {
            await database.set('chatluna_message', { id: grandchildId }, { parentId: id });
          }
        }
        await database.set('chatluna_conversation', { latestMessageId: toolId }, { latestMessageId: id });
        await database.remove('chatluna_message', { id: toolId });
      } else {
        const parentId = normalizeId(row.parentId) || null;
        for (const grandchild of grandchildren) {
          const grandchildId = normalizeId(grandchild.id);
          if (grandchildId) {
            await database.set('chatluna_message', { id: grandchildId }, { parentId });
          }
        }
        await database.set('chatluna_conversation', { latestMessageId: toolId }, { latestMessageId: parentId });
        await database.set('chatluna_conversation', { latestMessageId: id }, { latestMessageId: parentId });
        await database.remove('chatluna_message', { id: toolId });
        await database.remove('chatluna_message', { id });
      }
      passMigrated = 2;
      break;
    }

    if (passMigrated === 0) break;
    completedToolTraceRowsMigrated += passMigrated;
  }

  const remainingRows = await database.get('chatluna_message', {}, [...HISTORY_ROW_FIELDS]);
  const remainingRowsByParent = buildRowsByParent(remainingRows);
  const remainingRowsById = buildRowsById(remainingRows);
  const emptyAssistantRows = [];
  for (const row of remainingRows) {
    const id = normalizeId(row.id);
    if (!id || row.role !== 'ai') continue;
    if (!(await isStoredContentEmpty(row.content))) continue;
    if (parseToolCalls(row.tool_calls).length > 0) continue;
    emptyAssistantRows.push(row);
  }
  const emptyAssistantIds = new Set(emptyAssistantRows.map((row) => normalizeId(row.id)).filter(Boolean));

  for (const row of emptyAssistantRows) {
    const id = normalizeId(row.id);
    if (!id) continue;

    const parentId = resolveNearestKeptParentId(row, remainingRowsById, emptyAssistantIds);
    for (const child of remainingRowsByParent.get(id) ?? []) {
      const childId = normalizeId(child.id);
      if (childId && !emptyAssistantIds.has(childId)) {
        await database.set('chatluna_message', { id: childId }, { parentId });
      }
    }
    await database.set('chatluna_conversation', { latestMessageId: id }, { latestMessageId: parentId });
    await database.remove('chatluna_message', { id });
    emptyAssistantRowsRemoved += 1;
  }

  const migrated =
    structuredRowsMigrated +
    legacyDirectHumanRowsTagged +
    submitReplyPlansMigrated +
    emptySubmitReplyPlanToolsRemoved +
    protocolViolationPromptsRemoved +
    failedToolCallErrorRowsRemoved +
    danglingToolCallTailRowsRemoved +
    completedToolTraceRowsMigrated +
    transientAdditionalKwargsRowsCleaned +
    invisibleMessageNamesCleared +
    nonAiToolCallsCleared +
    emptyAssistantRowsRemoved;

  return {
    scanned: allRows.length,
    migrated,
    structuredRowsMigrated,
    legacyDirectHumanRowsTagged,
    submitReplyPlansMigrated,
    emptySubmitReplyPlanToolsRemoved,
    protocolViolationPromptsRemoved,
    failedToolCallErrorRowsRemoved,
    danglingToolCallTailRowsRemoved,
    completedToolTraceRowsMigrated,
    transientAdditionalKwargsRowsCleaned,
    invisibleMessageNamesCleared,
    nonAiToolCallsCleared,
    emptyAssistantRowsRemoved,
  };
}
