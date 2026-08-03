import type { StructuredReply, StructuredReplyMessage } from './types.js';

export const CHAT_REPLY_V1_PROTOCOL_ID = 'chat_reply_v1' as const;
export const CHAT_REPLY_V1_HEADER = 'CHAT_REPLY_V1';

export type ChatReplyV1ParseErrorCode =
  | 'MISSING_HEADER'
  | 'NONCE_MISMATCH'
  | 'UNKNOWN_COMMAND'
  | 'UNKNOWN_BLOCK_TYPE'
  | 'DUPLICATE_FIELD'
  | 'MISSING_FIELD'
  | 'PAYLOAD_LINE_WITHOUT_PIPE'
  | 'UNTERMINATED_BLOCK'
  | 'TRAILING_TEXT_AFTER_DONE';

export class ChatReplyV1ParseError extends Error {
  readonly protocol = CHAT_REPLY_V1_PROTOCOL_ID;

  constructor(
    readonly code: ChatReplyV1ParseErrorCode,
    readonly line: number,
    readonly column: number,
    readonly snippet: string,
    message: string,
  ) {
    super(`${code} at ${line}:${column}: ${message}`);
    this.name = 'ChatReplyV1ParseError';
  }
}

type BlockType = StructuredReplyMessage['type'];
type ContentBlockType = Exclude<BlockType, 'image'>;

interface ContentBlockBuilder {
  type: ContentBlockType;
  startLine: number;
  payload: string[];
}

interface ImageBlockBuilder {
  type: 'image';
  startLine: number;
  assetRef: string | null;
  alt: string[] | null;
}

type BlockBuilder = ContentBlockBuilder | ImageBlockBuilder;

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseError(code: ChatReplyV1ParseErrorCode, line: number, sourceLine: string, message: string): ChatReplyV1ParseError {
  return new ChatReplyV1ParseError(code, line, 1, sourceLine, message);
}

function splitLines(text: string): string[] {
  return stripBom(text).replace(/\r\n?/gu, '\n').split('\n');
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isBlockType(value: string): value is BlockType {
  return value === 'message' || value === 'structured_block' || value === 'image' || value === 'meme' || value === 'voice';
}

function requirePayload(block: BlockBuilder, lines: string[] | null, field: 'content' | 'ALT'): string {
  if (!lines?.length) {
    throw parseError('MISSING_FIELD', block.startLine, `BEGIN ${block.type}`, `${block.type} requires ${field}.`);
  }
  return lines.join('\n');
}

function requireAssetRef(block: ImageBlockBuilder): string {
  const value = block.assetRef;
  if (value == null || value.trim().length === 0) {
    throw parseError('MISSING_FIELD', block.startLine, `BEGIN ${block.type}`, `${block.type} requires ASSET_REF.`);
  }
  return value.trim();
}

function finalizeBlock(block: BlockBuilder): StructuredReplyMessage {
  switch (block.type) {
    case 'message':
      return {
        type: 'message',
        content: requirePayload(block, block.payload, 'content'),
      };
    case 'structured_block':
      return {
        type: 'structured_block',
        content: requirePayload(block, block.payload, 'content'),
      };
    case 'image':
      return {
        type: 'image',
        assetRef: requireAssetRef(block),
        alt: requirePayload(block, block.alt, 'ALT'),
      };
    case 'meme':
      return {
        type: 'meme',
        content: requirePayload(block, block.payload, 'content'),
      };
    case 'voice':
      return {
        type: 'voice',
        content: requirePayload(block, block.payload, 'content'),
      };
  }
}

function rejectRemovedContentSection(lineNumber: number, line: string): void {
  if (line !== 'CONTENT') return;
  throw parseError(
    'UNKNOWN_COMMAND',
    lineNumber,
    line,
    'CONTENT section is not supported; write payload lines directly after BEGIN.',
  );
}

export class ChatReplyV1Parser {
  parse(rawText: string): StructuredReply {
    const lines = splitLines(rawText);
    let index = 0;

    while (index < lines.length && isBlank(lines[index]!)) index += 1;
    if (index >= lines.length) {
      throw parseError('MISSING_HEADER', 1, '', `Expected ${CHAT_REPLY_V1_HEADER} header.`);
    }

    const headerLine = lines[index]!;
    const headerMatch = headerLine.match(/^CHAT_REPLY_V1\s+([A-Za-z0-9_-]{6,32})$/u);
    if (!headerMatch) {
      throw parseError('MISSING_HEADER', index + 1, headerLine, `Expected ${CHAT_REPLY_V1_HEADER} <nonce>.`);
    }
    const nonce = headerMatch[1]!;
    index += 1;

    while (index < lines.length && isBlank(lines[index]!)) index += 1;
    const decisionLine = lines[index] ?? '';
    const decisionMatch = decisionLine.match(/^DECISION\s+(reply|no_reply)$/u);
    if (!decisionMatch) {
      throw parseError('UNKNOWN_COMMAND', index + 1, decisionLine, 'Expected DECISION reply or DECISION no_reply.');
    }
    const decision = decisionMatch[1] as StructuredReply['decision'];
    index += 1;

    const messages: StructuredReplyMessage[] = [];
    let block: BlockBuilder | null = null;
    let done = false;

    for (; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index]!;

      if (done) {
        if (!isBlank(line)) {
          throw parseError('TRAILING_TEXT_AFTER_DONE', lineNumber, line, 'Only blank lines are allowed after DONE.');
        }
        continue;
      }

      const doneMatch = line.match(/^DONE\s+([A-Za-z0-9_-]{6,32})$/u);
      if (doneMatch) {
        if (block) {
          throw parseError('UNTERMINATED_BLOCK', block.startLine, `BEGIN ${block.type}`, 'Block was not closed before DONE.');
        }
        if (doneMatch[1] !== nonce) {
          throw parseError('NONCE_MISMATCH', lineNumber, line, 'DONE nonce does not match header nonce.');
        }
        done = true;
        continue;
      }

      if (block) {
        if (line === 'END') {
          messages.push(finalizeBlock(block));
          block = null;
          continue;
        }
        rejectRemovedContentSection(lineNumber, line);
        if (/^END(?:\s|$)/u.test(line)) {
          throw parseError('UNKNOWN_COMMAND', lineNumber, line, 'Blocks must close with bare END.');
        }

        if (block.type !== 'image') {
          if (!line.startsWith('|')) {
            throw parseError('PAYLOAD_LINE_WITHOUT_PIPE', lineNumber, line, 'Payload lines must start with |.');
          }
          block.payload.push(line.slice(1));
          continue;
        }

        if (block.alt != null) {
          if (line === 'ALT' || /^ASSET_REF(?:\s|$)/u.test(line)) {
            const field = line === 'ALT' ? 'ALT' : 'ASSET_REF';
            throw parseError('DUPLICATE_FIELD', lineNumber, line, `${field} already exists in this block.`);
          }
          if (!line.startsWith('|')) {
            throw parseError('PAYLOAD_LINE_WITHOUT_PIPE', lineNumber, line, 'Payload lines must start with |.');
          }
          block.alt.push(line.slice(1));
          continue;
        }

        if (line === 'ALT') {
          if (block.assetRef == null) {
            throw parseError('MISSING_FIELD', lineNumber, line, 'image requires ASSET_REF before ALT.');
          }
          block.alt = [];
          continue;
        }
        const assetRefMatch = line.match(/^ASSET_REF\s+(.+)$/u);
        if (assetRefMatch) {
          if (block.assetRef != null) {
            throw parseError('DUPLICATE_FIELD', lineNumber, line, 'ASSET_REF already exists in this block.');
          }
          block.assetRef = assetRefMatch[1]!;
          continue;
        }
        throw parseError('UNKNOWN_COMMAND', lineNumber, line, 'Expected ASSET_REF followed by ALT.');
      }

      if (isBlank(line)) continue;

      const beginMatch = line.match(/^BEGIN\s+([a-z_]+)$/u);
      if (beginMatch) {
        if (decision === 'no_reply') {
          throw parseError('UNKNOWN_COMMAND', lineNumber, line, 'DECISION no_reply cannot include message blocks.');
        }
        const blockType = beginMatch[1]!;
        if (!isBlockType(blockType)) {
          throw parseError('UNKNOWN_BLOCK_TYPE', lineNumber, line, `Unknown block type: ${blockType}.`);
        }
        if (messages.length >= 4) {
          throw parseError('UNKNOWN_COMMAND', lineNumber, line, 'DECISION reply allows at most four blocks.');
        }
        block = blockType === 'image'
          ? { type: 'image', startLine: lineNumber, assetRef: null, alt: null }
          : { type: blockType, startLine: lineNumber, payload: [] };
        continue;
      }

      throw parseError('UNKNOWN_COMMAND', lineNumber, line, 'Expected BEGIN or DONE.');
    }

    if (block) {
      throw parseError('UNTERMINATED_BLOCK', block.startLine, `BEGIN ${block.type}`, 'Block was not closed.');
    }
    if (!done) {
      throw parseError('UNKNOWN_COMMAND', lines.length, lines[lines.length - 1] ?? '', 'Missing DONE.');
    }
    if (decision === 'no_reply') {
      if (messages.length > 0) {
        throw parseError('UNKNOWN_COMMAND', 2, 'DECISION no_reply', 'DECISION no_reply cannot include messages.');
      }
      return { decision: 'no_reply', outbound_messages: null };
    }
    if (messages.length === 0) {
      throw parseError('MISSING_FIELD', 2, 'DECISION reply', 'DECISION reply requires at least one block.');
    }
    return { decision: 'reply', outbound_messages: messages };
  }
}

export function encodeChatReplyV1(reply: StructuredReply, nonce: string): string {
  const lines = [`${CHAT_REPLY_V1_HEADER} ${nonce}`, `DECISION ${reply.decision}`];
  if (reply.decision === 'reply') {
    for (const message of reply.outbound_messages ?? []) {
      lines.push(`BEGIN ${message.type}`);
      if (message.type === 'message') {
        lines.push(...message.content.split('\n').map((line) => `|${line}`));
      } else if (message.type === 'image') {
        lines.push(`ASSET_REF ${message.assetRef}`, 'ALT', ...message.alt.split('\n').map((line) => `|${line}`));
      } else {
        lines.push(...message.content.split('\n').map((line) => `|${line}`));
      }
      lines.push('END');
    }
  }
  lines.push(`DONE ${nonce}`);
  return lines.join('\n');
}
