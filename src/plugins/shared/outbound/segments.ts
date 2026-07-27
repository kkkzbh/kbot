import { h, type Fragment, type Session, type Universal } from 'koishi';

const MIN_SMART_SEND_DELAY_MS = 2000;
const MAX_SMART_SEND_DELAY_MS = 4000;
const NON_TEXT_SEGMENT_DELAY_MS = 2500;
const META_LEAK_REPLACEMENT_TEXT = '你在说什么怪话……我听不懂';
const bypassSplitOptions = new WeakSet<Universal.SendOptions>();
const LEAKED_REASONING_LINE_PATTERN =
  /(根据(?:之前|以上|当前)?的?对话|根据我的身份设定|用户(?:让我|让我去|让我搜|只说|曾(?:经)?|问|想|没有|没说)|我(?:需要|得|先|要|应该)(?:确认|判断|看看|先确认|以角色身份自然回应)|没有指定(?:具体)?(?:搜索)?内容|确认用户想让|搜索什么具体内容|不应该有特殊的技术能力|搜索工具(?:似乎|好像)?(?:不可用|有问题|出问题))/;
const LEAKED_REASONING_MARKER_PATTERN =
  /(用户让我搜索|根据我的身份设定|我应该以角色身份|我需要确认|搜索工具似乎不可用|不应该有特殊的技术能力|工具好像又出问题了)/g;
const LEAKED_REASONING_START_PATTERN =
  /^(?:用户(?:让我|要我|叫我|希望我)|根据(?:之前|以上|当前)?的?对话|根据我的身份设定|我(?:需要|得|要|应该))/;
const SEARCH_INTENT_HINT_PATTERN = /(搜|搜索|web_run|联网|查一下|查一查)/i;
const META_LEAK_SELF_REFERENCE_PATTERN =
  /(?:^|[\s，。！？!?])(?:我(?:是|作为|不是|并非|需要|得|要|必须|不能|不会|没法)|根据(?:我的)?(?:身份|系统)?设定|按照(?:系统)?(?:提示词|规则|设定|指令)|提示词(?:要求|规定|写着)|系统(?:提示词|消息|规则|指令)(?:要求|规定)|(?:扮演|身份)设定(?:要求|规定))/i;
const META_LEAK_KEYWORD_PATTERN =
  /(系统提示词|system prompt|prompt|提示词|系统消息|隐藏指令|越狱|AI|人工智能|模型|语言模型|机器人|扮演设定|身份设定)/i;
const FENCED_CODE_BLOCK_PATTERN = /^```[^\n\r]*\r?\n([\s\S]*?)\r?\n```$/;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const STRONG_EMPHASIS_PATTERN = /\*\*([^*\n]+)\*\*/g;
const ALT_STRONG_EMPHASIS_PATTERN = /__([^_\n]+)__/g;
const EMPHASIS_PATTERN = /(^|[^\w])\*([^*\n]+)\*(?=[^\w]|$)/g;
const ALT_EMPHASIS_PATTERN = /(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g;
const HEADING_PREFIX_PATTERN = /^\s{0,3}#{1,6}\s+/;
const BLOCKQUOTE_PREFIX_PATTERN = /^\s{0,3}>\s?/;
const UNORDERED_LIST_PREFIX_PATTERN = /^(\s*)[-*+]\s+/;
const ORDERED_LIST_PREFIX_PATTERN = /^(\s*)(\d+)[.)]\s+/;
const XML_MENTION_TOKEN_PATTERN = /<at\b[\s\S]*?\/>/gi;
const CQ_MENTION_TOKEN_PATTERN = /\[CQ:at,[^\]]+\]/gi;

type AsyncTask<T> = () => Promise<T>;

export interface KeyedStrandRunner {
  run<T>(key: string, task: AsyncTask<T>): Promise<T>;
}

export type OutboundMessageMode = 'split' | 'preserve';

export interface NormalizedOutboundMessage {
  mode: OutboundMessageMode;
  content: string;
}

export interface ReplyMention {
  userId: string;
  content?: string;
}

export type OutboundMessageSegment =
  | {
      kind: 'text-line';
      content: string;
      raw: string;
    }
  | {
      kind: 'voice-block';
      content: string;
      raw: string;
    }
  | {
      kind: 'sticker-block';
      content: string;
      raw: string;
    }
  | {
      kind: 'image-block';
      assetRef: string;
      alt?: string;
      raw: string;
    }
  | {
      kind: 'message-block';
      parts: ReplyMessagePart[];
      raw: string;
    }
  | {
      kind: 'structured-block';
      content: string;
      raw: string;
    };

export interface OutboundMessagePlan {
  segments: OutboundMessageSegment[];
}

export type ReplyTransportSegmentKind = 'message' | 'structured_block' | 'voice' | 'sticker' | 'image';
export type StructuredReplyTextKind =
  | 'message'
  | 'mention'
  | 'structured_block'
  | 'voice'
  | 'sticker'
  | 'meme'
  | 'image_alt';

export type ReplyTransportSegment =
  | {
      kind: 'message';
      parts: ReplyMessagePart[];
    }
  | {
      kind: 'structured_block';
      content: string;
    }
  | {
      kind: 'voice' | 'sticker';
      content: string;
    }
  | {
      kind: 'image';
      assetRef: string;
      alt?: string;
    };

export interface ReplyTransportPlan {
  segments: ReplyTransportSegment[];
}

export type BotMessageContent = Fragment;

export type ReplyMessagePart =
  | {
      kind: 'text';
      content: string;
    }
  | {
      kind: 'at';
      userId: string;
      label?: string;
    };

export type BotMessageSender = {
  sendMessage: (
    channelId: string,
    content: BotMessageContent,
    guildId?: string,
    options?: Universal.SendOptions,
  ) => Promise<unknown>;
};

export type SessionStrandLike = {
  platform?: string;
  isDirect?: boolean;
  channelId?: string;
  guildId?: string;
  userId?: string;
  bot?: {
    selfId?: string;
  };
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createKeyedStrandRunner(): KeyedStrandRunner {
  const tails = new Map<string, Promise<void>>();

  return {
    async run<T>(key: string, task: AsyncTask<T>): Promise<T> {
      const tail = tails.get(key);
      const previous = tail ? tail.catch(() => undefined) : Promise.resolve();
      let releaseCurrent: () => void = () => {};
      const current = new Promise<void>((resolve) => {
        releaseCurrent = () => resolve();
      });
      const nextTail = previous.then(() => current);
      tails.set(key, nextTail);

      await previous;

      try {
        return await task();
      } finally {
        releaseCurrent();
        if (tails.get(key) === nextTail) {
          tails.delete(key);
        }
      }
    },
  };
}

function resolvePrefixedScope(idLike: string | undefined): string | null {
  const normalized = idLike?.trim();
  if (!normalized) return null;

  const matched = normalized.match(/^(private|group):(.+)$/i);
  if (!matched) return null;

  const scope = matched[1]?.toLowerCase();
  const id = matched[2]?.trim();
  if (!scope || !id) return null;
  return `${scope}:${id}`;
}

function resolveSessionStrandScope(session: SessionStrandLike): string | null {
  const channelScope = resolvePrefixedScope(session.channelId);
  if (channelScope) return channelScope;

  const guildScope = resolvePrefixedScope(session.guildId);
  if (guildScope) return guildScope;

  if (session.isDirect) {
    const privateId = session.channelId?.trim() || session.userId?.trim();
    return privateId ? `private:${privateId}` : null;
  }

  const groupId = session.channelId?.trim() || session.guildId?.trim();
  if (groupId) return `group:${groupId}`;

  return null;
}

export function resolveSessionStrandKey(session: SessionStrandLike): string | null {
  return resolveReplyQueueKey(session);
}

export function resolveReplyQueueKey(session: SessionStrandLike): string | null {
  const platform = session.platform?.trim();
  if (!platform) return null;

  const botSelfId = session.bot?.selfId?.trim();
  if (!botSelfId) return null;

  const scope = resolveSessionStrandScope(session);
  if (!scope) return null;

  return `${platform}:${botSelfId}:${scope}`;
}

export function resolveReplyActorKey(session: SessionStrandLike): string | null {
  const queueKey = resolveReplyQueueKey(session);
  if (!queueKey) return null;

  const scope = resolveSessionStrandScope(session);
  if (!scope) return null;
  if (scope.startsWith('private:')) return queueKey;

  const userId = session.userId?.trim();
  if (!userId) return null;
  return `${queueKey}:user:${userId}`;
}

export function createBypassLineSplitOptions(session?: Session): Universal.SendOptions {
  const options: Universal.SendOptions = session ? { session } : {};
  bypassSplitOptions.add(options);
  return options;
}

export function shouldBypassLineSplit(options: Universal.SendOptions): boolean {
  return bypassSplitOptions.has(options);
}

export function createBotMessageDispatchers(
  bot: BotMessageSender,
  channelId: string,
  session?: Session,
): {
  sendWhole: (content: BotMessageContent) => Promise<unknown>;
  sendLine: (line: BotMessageContent) => Promise<unknown>;
} {
  return {
    sendWhole: async (content: BotMessageContent) =>
      bot.sendMessage(channelId, toExplicitMessageContent(content), undefined, createBypassLineSplitOptions(session)),
    sendLine: async (line: BotMessageContent) =>
      bot.sendMessage(channelId, toExplicitMessageContent(line), undefined, createBypassLineSplitOptions(session)),
  };
}

export function createSessionMessageDispatchers(session: Session): {
  sendWhole: (content: BotMessageContent) => Promise<unknown>;
  sendLine: (line: BotMessageContent) => Promise<unknown>;
} {
  return {
    sendWhole: async (content: BotMessageContent) =>
      session.send(toExplicitMessageContent(content), createBypassLineSplitOptions(session)),
    sendLine: async (line: BotMessageContent) =>
      session.send(toExplicitMessageContent(line), createBypassLineSplitOptions(session)),
  };
}

function toExplicitMessageContent(content: BotMessageContent): Exclude<BotMessageContent, string> {
  return typeof content === 'string' ? h.text(content) : content;
}

function toMessageElements(content: BotMessageContent): Array<ReturnType<typeof h>> {
  if (Array.isArray(content)) {
    return content.map((item) => (typeof item === 'string' ? h.text(item) : item));
  }
  if (typeof content === 'string') {
    return [h.text(content)];
  }
  return [content];
}

function sanitizeMentionText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function normalizeMention(mention: ReplyMention): ReplyMention | null {
  const userId = mention.userId.trim();
  if (!userId) return null;

  const normalizedContent =
    typeof mention.content === 'string'
      ? sanitizeStructuredReplyText(sanitizeMentionText(mention.content), 'mention')
      : '';

  return normalizedContent
    ? {
        userId,
        content: normalizedContent,
      }
    : {
        userId,
      };
}

export function renderMentionVisibleText(mention: ReplyMention): string {
  const normalized = normalizeMention(mention);
  if (!normalized) return '';
  return normalized.content ? `@${normalized.userId} ${normalized.content}` : `@${normalized.userId}`;
}

function normalizeReplyMessageParts(parts: ReplyMessagePart[]): ReplyMessagePart[] {
  const normalized: ReplyMessagePart[] = [];

  for (const part of parts) {
    if (part.kind === 'at') {
      const userId = part.userId.trim();
      if (!userId) continue;
      normalized.push({
        kind: 'at',
        userId,
        ...(part.label?.trim() ? { label: part.label.trim() } : {}),
      });
      continue;
    }

    const content = sanitizeReplyMessagePartText(part.content);
    if (!content) continue;
    const previous = normalized[normalized.length - 1];
    if (previous?.kind === 'text') {
      previous.content = `${previous.content}${content}`;
    } else {
      normalized.push({ kind: 'text', content });
    }
  }

  return normalized;
}

function sanitizeReplyMessagePartText(content: string): string {
  const normalized = normalizeLineEndings(content);
  const leading = normalized.match(/^[ \t\u3000]*/u)?.[0] ?? '';
  const trailing = normalized.match(/[ \t\u3000]*$/u)?.[0] ?? '';
  const coreStart = leading.length;
  const coreEnd = normalized.length - trailing.length;
  const core = coreEnd > coreStart ? normalized.slice(coreStart, coreEnd) : '';
  if (!core) return leading || trailing;
  return `${leading}${normalizeMessageBlockContent(core)}${trailing}`;
}

function renderReplyMessagePartsVisibleText(parts: ReplyMessagePart[]): string {
  return normalizeReplyMessageParts(parts)
    .map((part) => (part.kind === 'at' ? `@${part.userId}` : part.content))
    .join('')
    .trim();
}

export function renderMessageVisibleText(message: { parts: ReplyMessagePart[] }): string {
  return renderReplyMessagePartsVisibleText(message.parts);
}

export function renderModelFacingMessageText(message: { parts: ReplyMessagePart[] }): string {
  const parts = normalizeReplyMessageParts(message.parts);
  const text = parts
    .filter((part): part is Extract<ReplyMessagePart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.content)
    .join('')
    .trim();
  if (text) return text;

  const mentionedIds = parts
    .filter((part): part is Extract<ReplyMessagePart, { kind: 'at' }> => part.kind === 'at')
    .map((part) => part.userId);
  return mentionedIds.length ? `（提及用户：${mentionedIds.join('、')}）` : '';
}

export function createMentionMessageContent(
  mention: ReplyMention,
  options: { separator?: 'space' | 'newline' | 'none' } = {},
): BotMessageContent {
  const normalized = normalizeMention(mention);
  if (!normalized) return [];
  if (!normalized.content) return h.at(normalized.userId);

  const separator = options.separator ?? 'space';
  const prefix = separator === 'newline' ? '\n' : separator === 'none' ? '' : ' ';
  return [h.at(normalized.userId), h.text(`${prefix}${normalized.content}`)];
}

export function createMessageMessageContent(message: { parts: ReplyMessagePart[] }): BotMessageContent {
  const parts = normalizeReplyMessageParts(message.parts);
  if (!parts.length) return h.text('');

  const elements = parts.map((part) => (part.kind === 'at' ? h.at(part.userId) : h.text(part.content)));
  return elements.length === 1 ? elements[0]! : elements;
}

export function createQuotedMessageContent(content: BotMessageContent, targetMessageId?: string | null): BotMessageContent {
  const normalizedTarget = typeof targetMessageId === 'string' ? targetMessageId.trim() : '';
  if (!normalizedTarget) return content;
  return [h('quote', { id: normalizedTarget }), ...toMessageElements(content)];
}

function normalizeLineEndings(message: string): string {
  return message.replace(/\r\n?/g, '\n');
}

function flattenMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => flattenMessageText(part)).join('');
  if (!content || typeof content !== 'object') return '';

  const node = content as {
    type?: string;
    content?: unknown;
    attrs?: { content?: unknown };
    children?: unknown[];
  };

  const ownText =
    typeof node.attrs?.content === 'string'
      ? node.attrs.content
      : typeof node.content === 'string'
        ? node.content
        : '';
  const childText = Array.isArray(node.children) ? node.children.map((child) => flattenMessageText(child)).join('') : '';
  const combined = `${ownText}${childText}`;
  if (!combined) return '';
  if (node.type && node.type !== 'text' && node.type !== 'span') {
    return `${combined}\n`;
  }
  return combined;
}

function trimPreservedContent(content: string): string {
  const normalized = normalizeLineEndings(content);
  return normalized.replace(/^\n/, '').replace(/\n$/, '').trimEnd();
}

function unwrapFencedCodeBlock(message: string): string {
  const normalized = normalizeLineEndings(message).trim();
  const matched = normalized.match(FENCED_CODE_BLOCK_PATTERN);
  return matched?.[1] ?? message;
}

function stripInlineMarkdownDecorations(message: string): string {
  let normalized = normalizeLineEndings(message);
  normalized = normalized.replace(MARKDOWN_LINK_PATTERN, '$1 $2');
  normalized = normalized.replace(INLINE_CODE_PATTERN, '$1');
  normalized = normalized.replace(STRONG_EMPHASIS_PATTERN, '$1');
  normalized = normalized.replace(ALT_STRONG_EMPHASIS_PATTERN, '$1');
  normalized = normalized.replace(EMPHASIS_PATTERN, '$1$2');
  normalized = normalized.replace(ALT_EMPHASIS_PATTERN, '$1$2');
  return normalized;
}

function stripSplitModeMarkdown(message: string): string {
  const normalized = stripInlineMarkdownDecorations(unwrapFencedCodeBlock(message));

  const lines = normalized.split('\n').map((line) => {
    let next = line;
    next = next.replace(HEADING_PREFIX_PATTERN, '');
    next = next.replace(BLOCKQUOTE_PREFIX_PATTERN, '');
    next = next.replace(UNORDERED_LIST_PREFIX_PATTERN, '$1');
    return next;
  });

  return lines.join('\n').trim();
}

function stripPreserveModeMarkdown(message: string): string {
  return trimPreservedContent(unwrapFencedCodeBlock(message));
}

function sanitizePromptLeakMessage(message: string): string {
  const normalized = normalizeLineEndings(message).trim();
  if (!normalized) return normalized;
  if (!META_LEAK_SELF_REFERENCE_PATTERN.test(normalized)) return normalized;
  if (!META_LEAK_KEYWORD_PATTERN.test(normalized)) return normalized;
  return META_LEAK_REPLACEMENT_TEXT;
}

function normalizeSplitChunkToSegments(rawChunk: string): OutboundMessageSegment[] {
  const markdownStripped = stripSplitModeMarkdown(rawChunk);
  const reasoningSanitized = sanitizeLeakedReasoningMessage(markdownStripped);
  const promptSanitized = sanitizePromptLeakMessage(reasoningSanitized);
  const lines = dropLeadingLeakedReasoningLines(splitMessageByLines(promptSanitized));

  return lines.map((line) => ({
    kind: 'text-line' as const,
    content: line,
    raw: line,
  }));
}

function normalizePreservedBlockContent(rawContent: string): string {
  return sanitizePromptLeakMessage(stripPreserveModeMarkdown(rawContent));
}

function normalizeMessageBlockContent(rawContent: string): string {
  const normalized = stripInlineMarkdownDecorations(unwrapFencedCodeBlock(rawContent));
  const lines = normalized.split('\n').map((line) => {
    let next = line;
    next = next.replace(HEADING_PREFIX_PATTERN, '');
    next = next.replace(BLOCKQUOTE_PREFIX_PATTERN, '');
    next = next.replace(UNORDERED_LIST_PREFIX_PATTERN, '$1');
    next = next.replace(ORDERED_LIST_PREFIX_PATTERN, '');
    return next;
  });

  return sanitizePromptLeakMessage(stripManualMentionTokens(trimPreservedContent(lines.join('\n'))));
}

function normalizeStructuredBlockContent(rawContent: string): string {
  const normalized = normalizeLineEndings(rawContent).trim();
  const fencedMatch = normalized.match(FENCED_CODE_BLOCK_PATTERN);
  if (fencedMatch) {
    return sanitizePromptLeakMessage(trimPreservedContent(fencedMatch[1] ?? ''));
  }

  const stripped = stripInlineMarkdownDecorations(normalized);
  const lines = stripped.split('\n').map((line) => {
    let next = line;
    next = next.replace(HEADING_PREFIX_PATTERN, '');
    next = next.replace(BLOCKQUOTE_PREFIX_PATTERN, '');
    next = next.replace(UNORDERED_LIST_PREFIX_PATTERN, '- ');
    next = next.replace(ORDERED_LIST_PREFIX_PATTERN, '$1$2. ');
    return next;
  });

  return sanitizePromptLeakMessage(trimPreservedContent(lines.join('\n')));
}

export function sanitizeStructuredReplyText(rawContent: string, kind: StructuredReplyTextKind = 'message'): string {
  switch (kind) {
    case 'message':
    case 'mention':
      return normalizeMessageBlockContent(rawContent);
    case 'structured_block':
      return normalizeStructuredBlockContent(rawContent);
    case 'voice':
    case 'sticker':
    case 'meme':
    case 'image_alt':
      return normalizePreservedBlockContent(rawContent);
    default:
      return normalizePreservedBlockContent(rawContent);
  }
}

function stripManualMentionTokens(message: string): string {
  return message
    .replace(XML_MENTION_TOKEN_PATTERN, ' ')
    .replace(CQ_MENTION_TOKEN_PATTERN, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function sanitizeStructuredReplySegmentContent(rawContent: string): string {
  return sanitizeStructuredReplyText(rawContent, 'message');
}

export function createTextOutboundSegments(message: string): OutboundMessageSegment[] {
  return normalizeSplitChunkToSegments(message);
}

export function createTextOnlyOutboundMessagePlan(message: unknown): OutboundMessagePlan {
  const flattened = flattenMessageText(message);
  return {
    segments: createTextOutboundSegments(flattened),
  };
}

function splitReplyMessagePartsByLines(parts: ReplyMessagePart[]): ReplyMessagePart[][] {
  const lines: ReplyMessagePart[][] = [[]];

  const pushText = (content: string) => {
    const currentLine = lines[lines.length - 1]!;
    const previous = currentLine[currentLine.length - 1];
    if (previous?.kind === 'text') {
      previous.content = `${previous.content}${content}`;
    } else {
      currentLine.push({ kind: 'text', content });
    }
  };

  for (const part of parts) {
    if (part.kind === 'at') {
      lines[lines.length - 1]!.push(part);
      continue;
    }

    const chunks = normalizeLineEndings(part.content).split('\n');
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) lines.push([]);
      if (chunk) pushText(chunk);
    }
  }

  return lines
    .map((line) => normalizeReplyMessageParts(line))
    .filter((line) => line.some((part) => part.kind === 'at' || (part.kind === 'text' && part.content.trim().length > 0)));
}

export function buildOutboundMessagePlanFromReplyPlan(plan: ReplyTransportPlan): OutboundMessagePlan {
  const segments: OutboundMessageSegment[] = [];
  const createStructuredRaw = (kind: ReplyTransportSegmentKind, index: number, value: string): string =>
    `reply-plan:${kind}:${index}:${value}`;

  for (const [index, segment] of plan.segments.entries()) {
    if (segment.kind === 'message') {
      const parts = normalizeReplyMessageParts(segment.parts);
      if (!parts.length) continue;
      const lines = splitReplyMessagePartsByLines(parts);
      if (!lines.length && parts.some((part) => part.kind === 'at')) {
        segments.push({
          kind: 'message-block',
          parts,
          raw: createStructuredRaw(segment.kind, index, renderMessageVisibleText({ parts })),
        });
        continue;
      }

      for (const [lineIndex, lineParts] of lines.entries()) {
        if (lineParts.some((part) => part.kind === 'at')) {
          segments.push({
            kind: 'message-block',
            parts: lineParts,
            raw: createStructuredRaw(segment.kind, index, renderMessageVisibleText({ parts: lineParts })),
          });
          continue;
        }

        const line = renderMessageVisibleText({ parts: lineParts });
        if (!line) continue;

        segments.push({
          kind: 'text-line',
          content: line,
          raw: createStructuredRaw(segment.kind, index, `line:${lineIndex}:${line}`),
        });
      }
      continue;
    }

    if (segment.kind === 'structured_block') {
      const content = sanitizeStructuredReplyText(segment.content, 'structured_block');
      if (!content.trim()) continue;
      segments.push({
        kind: 'structured-block',
        content,
        raw: createStructuredRaw(segment.kind, index, content),
      });
      continue;
    }

    if (segment.kind === 'image') {
      const assetRef = segment.assetRef.trim();
      if (!assetRef) continue;
      const alt = segment.alt?.trim() || undefined;
      segments.push({
        kind: 'image-block',
        assetRef,
        alt,
        raw: createStructuredRaw(segment.kind, index, assetRef),
      });
      continue;
    }

    const content = sanitizeStructuredReplyText(
      segment.content,
      segment.kind === 'sticker' ? 'sticker' : 'voice',
    );
    if (!content.trim()) continue;

    if (segment.kind === 'sticker') {
      segments.push({
        kind: 'sticker-block',
        content,
        raw: createStructuredRaw(segment.kind, index, content),
      });
      continue;
    }

    segments.push({
      kind: 'voice-block',
      content,
      raw: createStructuredRaw(segment.kind, index, content),
    });
  }

  return { segments };
}

export function renderOutboundMessageSegmentsHistoryText(segments: OutboundMessageSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.kind === 'sticker-block') {
        return `（发送表情包：${segment.content}）`;
      }

      if (segment.kind === 'voice-block') {
        return `（发送语音：${segment.content}）`;
      }

      if (segment.kind === 'image-block') {
        return segment.alt ? `（发送图片：${segment.alt}）` : '（发送图片）';
      }

      if (segment.kind === 'message-block') {
        return renderMessageVisibleText(segment);
      }

      if (segment.kind === 'structured-block') {
        return segment.content;
      }

      return segment.content;
    })
    .filter((segment) => segment.trim().length > 0)
    .join('\n')
    .trim();
}

export async function dispatchOutboundMessagePlan(
  plan: OutboundMessagePlan,
  sendSegment: (segment: OutboundMessageSegment) => Promise<unknown>,
  options: { abortSignal?: AbortSignal } = {},
): Promise<void> {
  for (let index = 0; index < plan.segments.length; index += 1) {
    if (options.abortSignal?.aborted) return;
    const segment = plan.segments[index];
    await sendSegment(segment);
    if (options.abortSignal?.aborted) return;

    const nextSegment = plan.segments[index + 1];
    if (!nextSegment) continue;

    const delayMs =
      segment.kind === 'text-line' || segment.kind === 'message-block' || segment.kind === 'structured-block'
        ? calculateSmartSendDelayMs(
            segment.kind === 'text-line'
              ? segment.content
              : segment.kind === 'message-block'
                ? renderMessageVisibleText(segment)
                : segment.content,
          )
        : NON_TEXT_SEGMENT_DELAY_MS;
    await sleep(delayMs, options.abortSignal);
  }
}

export async function dispatchNormalizedOutboundMessageWithMention(
  message: NormalizedOutboundMessage,
  mentionUserId: string,
  sendWhole: (content: BotMessageContent) => Promise<unknown>,
  sendLine: (line: BotMessageContent) => Promise<unknown>,
): Promise<void> {
  const normalizedUserId = mentionUserId.trim();
  if (!normalizedUserId) {
    await dispatchNormalizedOutboundMessage(message, sendWhole, sendLine);
    return;
  }

  if (message.mode === 'preserve') {
    const content = message.content.trim();
    if (!content) {
      await sendWhole(createMentionMessageContent({ userId: normalizedUserId }));
      return;
    }
    await sendWhole(createMentionMessageContent({ userId: normalizedUserId, content }, { separator: 'newline' }));
    return;
  }

  const content = message.content.trim();
  if (!content) {
    await sendWhole(createMentionMessageContent({ userId: normalizedUserId }));
    return;
  }

  const lines = splitMessageByLines(content);
  if (!lines.length) {
    await sendWhole(createMentionMessageContent({ userId: normalizedUserId }));
    return;
  }

  await sendWhole(createMentionMessageContent({ userId: normalizedUserId, content: lines[0]! }, { separator: 'space' }));

  for (let index = 1; index < lines.length; index += 1) {
    await sendLine(lines[index]!);
  }
}

export function splitMessageByLines(message: string): string[] {
  const normalized = normalizeLineEndings(message);
  const lines = normalized.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length) return lines;
  const fallback = message.trim();
  return fallback ? [fallback] : [];
}

export function looksLikeLeakedReasoningLine(line: string): boolean {
  const text = line.trim();
  if (text.length < 20) return false;
  return LEAKED_REASONING_LINE_PATTERN.test(text);
}

export function dropLeadingLeakedReasoningLines(lines: string[]): string[] {
  let index = 0;
  while (lines.length - index > 1 && looksLikeLeakedReasoningLine(lines[index])) {
    index += 1;
  }
  return index > 0 ? lines.slice(index) : lines;
}

function splitBySentence(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  return normalized.match(/[^。！？!?]+[。！？!?]?/g)?.map((item) => item.trim()).filter(Boolean) ?? [normalized];
}

function stripLeakedReasoningFromLine(line: string): string {
  const segments = splitBySentence(line);
  if (!segments.length) return '';
  const filtered = segments.filter((segment) => !LEAKED_REASONING_LINE_PATTERN.test(segment));
  return filtered.join('').trim();
}

export function sanitizeLeakedReasoningMessage(message: string): string {
  const normalized = normalizeLineEndings(message).trim();
  if (!normalized) return normalized;

  const markerCount = (normalized.match(LEAKED_REASONING_MARKER_PATTERN) ?? []).length;
  const startsLikeLeak = LEAKED_REASONING_START_PATTERN.test(normalized);
  const likelyLeak = startsLikeLeak || markerCount >= 2;
  if (!likelyLeak) return normalized;

  const strippedLines = dropLeadingLeakedReasoningLines(splitMessageByLines(normalized))
    .map((line) => stripLeakedReasoningFromLine(line))
    .filter(Boolean);

  if (strippedLines.length) return strippedLines.join('\n');

  return SEARCH_INTENT_HINT_PATTERN.test(normalized)
    ? '你想让我搜什么具体内容呢？'
    : '你再具体说一下，我好准确回复你';
}

export function normalizeOutboundMessage(message: string): NormalizedOutboundMessage {
  return {
    mode: 'split',
    content: createTextOutboundSegments(message)
      .map((segment) => ('content' in segment ? segment.content : ''))
      .join('\n')
      .trim(),
  };
}

export function calculateSmartSendDelayMs(line: string): number {
  const text = line.trim();
  if (!text) return MIN_SMART_SEND_DELAY_MS;

  const cjkCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const alphaNumCount = (text.match(/[A-Za-z0-9]/g) ?? []).length;
  const nonSpaceCount = text.replace(/\s+/g, '').length;
  const symbolCount = Math.max(0, nonSpaceCount - cjkCount - alphaNumCount);
  const punctuationCount = (text.match(/[，。！？；：,.!?;:]/g) ?? []).length;

  const weightedLength = cjkCount + alphaNumCount * 0.6 + symbolCount * 0.8;
  const estimate = Math.round(900 + weightedLength * 55 + punctuationCount * 180);
  return clamp(estimate, MIN_SMART_SEND_DELAY_MS, MAX_SMART_SEND_DELAY_MS);
}

export async function sendByLinesWithSmartInterval(
  message: string,
  sendLine: (line: string) => Promise<unknown>,
): Promise<void> {
  const lines = splitMessageByLines(message);
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) {
      const delayMs = calculateSmartSendDelayMs(lines[index - 1]);
      await sleep(delayMs);
    }
    await sendLine(lines[index]);
  }
}

export async function dispatchNormalizedOutboundMessage(
  message: NormalizedOutboundMessage,
  sendWhole: (content: BotMessageContent) => Promise<unknown>,
  sendLine: (line: BotMessageContent) => Promise<unknown>,
): Promise<void> {
  if (message.mode === 'preserve') {
    if (!message.content.trim()) return;
    await sendWhole(message.content);
    return;
  }

  const content = message.content.trim();
  if (!content) return;

  const lines = splitMessageByLines(content);
  if (!lines.length) return;
  if (lines.length === 1) {
    await sendWhole(lines[0]);
    return;
  }

  await sendByLinesWithSmartInterval(lines.join('\n'), sendLine);
}

export async function sendBotMessageByNormalizedContent(
  bot: BotMessageSender,
  channelId: string,
  message: string | NormalizedOutboundMessage,
  session?: Session,
): Promise<void> {
  const normalized = typeof message === 'string' ? normalizeOutboundMessage(message) : message;
  const { sendWhole, sendLine } = createBotMessageDispatchers(bot, channelId, session);
  await dispatchNormalizedOutboundMessage(normalized, sendWhole, sendLine);
}
