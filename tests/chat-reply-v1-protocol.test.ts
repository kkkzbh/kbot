import { describe, expect, it } from 'vitest';
import {
  ChatReplyV1ParseError,
  ChatReplyV1Parser,
  encodeChatReplyV1,
} from '../src/plugins/reply/pipeline/chat-reply-v1.js';

const parser = new ChatReplyV1Parser();

describe('CHAT_REPLY_V1 protocol', () => {
  it('parses no_reply', () => {
    expect(parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION no_reply',
      'DONE abc12345',
    ].join('\n'))).toEqual({
      decision: 'no_reply',
      outbound_messages: null,
    });
  });

  it('parses all supported block types', () => {
    const reply = parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN message',
      '|@123 第一条',
      '|第二行',
      'END',
      'BEGIN structured_block',
      '|```ts',
      '|console.log("END")',
      '|```',
      'END',
      'BEGIN image',
      'ASSET_REF asset:tool:cf-card:01ABC',
      'ALT',
      '|Codeforces 用户分数卡',
      'END',
      'BEGIN meme',
      '|无语地看对方一眼',
      'END',
      'DONE abc12345',
    ].join('\n'));

    expect(reply).toEqual({
      decision: 'reply',
      outbound_messages: [
        { type: 'message', content: '@123 第一条\n第二行' },
        { type: 'structured_block', content: '```ts\nconsole.log("END")\n```' },
        { type: 'image', assetRef: 'asset:tool:cf-card:01ABC', alt: 'Codeforces 用户分数卡' },
        { type: 'meme', content: '无语地看对方一眼' },
      ],
    });
  });

  it('parses voice blocks with the canonical bare END marker', () => {
    expect(parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN voice',
      '|本当にうれしいです。',
      'END',
      'DONE abc12345',
    ].join('\n'))).toEqual({
      decision: 'reply',
      outbound_messages: [
        { type: 'voice', content: '本当にうれしいです。' },
      ],
    });
  });

  it.each([
    ['typed END', [
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN voice',
      '|おはようございます。',
      'END voice',
      'DONE abc12345',
    ]],
    ['redundant typed END', [
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN voice',
      '|おはようございます。',
      'END',
      'END voice',
      'DONE abc12345',
    ]],
  ])('rejects the removed %s form', (_label, lines) => {
    expect(() => parser.parse(lines.join('\n'))).toThrow(expect.objectContaining({
      code: 'UNKNOWN_COMMAND',
    }));
  });

  it('treats protocol-looking payload lines as content when prefixed with pipe', () => {
    expect(parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN structured_block',
      '|END',
      '|DONE abc12345',
      '|BEGIN image',
      'END',
      'DONE abc12345',
    ].join('\n')).outbound_messages?.[0]).toEqual({
      type: 'structured_block',
      content: 'END\nDONE abc12345\nBEGIN image',
    });
  });

  it('parses explicit pipe-prefixed empty payload lines', () => {
    expect(parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN message',
      '|第一段',
      '|',
      '|第二段',
      '|',
      '|第三段',
      'END',
      'DONE abc12345',
    ].join('\n'))).toEqual({
      decision: 'reply',
      outbound_messages: [
        { type: 'message', content: '第一段\n\n第二段\n\n第三段' },
      ],
    });
  });

  it.each(['', 'bare paragraph'])('rejects non-pipe payload line %j', (payloadLine) => {
    const text = [
      'CHAT_REPLY_V1 history',
      'DECISION reply',
      'BEGIN message',
      '|篮球……国一？',
      payloadLine,
      'END',
      'DONE history',
    ].join('\n');

    expect(() => parser.parse(text)).toThrow(expect.objectContaining({
      code: 'PAYLOAD_LINE_WITHOUT_PIPE',
    }));
  });

  it('round-trips generated protocol text', () => {
    const original = {
      decision: 'reply' as const,
      outbound_messages: [
        { type: 'message' as const, content: '一\n二\nEND' },
        { type: 'meme' as const, content: '轻轻叹气' },
      ],
    };

    const encoded = encodeChatReplyV1(original, 'abc12345');
    expect(encoded).not.toContain('\nCONTENT\n');
    expect(parser.parse(encoded)).toEqual(original);
  });

  it('parses message blocks without a legacy mention header', () => {
    expect(parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN message',
      '|在我看来算是个不错的成绩筹码',
      'END',
      'DONE abc12345',
    ].join('\n'))).toEqual({
      decision: 'reply',
      outbound_messages: [
        {
          type: 'message',
          content: '在我看来算是个不错的成绩筹码',
        },
      ],
    });
  });

  it.each([
    ['MISSING_HEADER', 'hello\nCHAT_REPLY_V1 abc12345\nDECISION no_reply\nDONE abc12345'],
    ['NONCE_MISMATCH', 'CHAT_REPLY_V1 abc12345\nDECISION no_reply\nDONE zzz99999'],
    ['UNKNOWN_COMMAND', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nhello\nDONE abc12345'],
    ['UNKNOWN_BLOCK_TYPE', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN poll\nEND\nDONE abc12345'],
    ['DUPLICATE_FIELD', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN image\nASSET_REF asset:a\nASSET_REF asset:b\nALT\n|hi\nEND\nDONE abc12345'],
    ['DUPLICATE_FIELD', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN image\nASSET_REF asset:a\nALT\n|hi\nALT\nEND\nDONE abc12345'],
    ['MISSING_FIELD', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN message\nEND\nDONE abc12345'],
    ['MISSING_FIELD', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN image\nALT\n|hi\nEND\nDONE abc12345'],
    ['MISSING_FIELD', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN image\nASSET_REF asset:a\nEND\nDONE abc12345'],
    ['UNTERMINATED_BLOCK', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN message\n|hi\nDONE abc12345'],
    ['TRAILING_TEXT_AFTER_DONE', 'CHAT_REPLY_V1 abc12345\nDECISION no_reply\nDONE abc12345\nextra'],
    ['PAYLOAD_LINE_WITHOUT_PIPE', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN message\nMENTIONS u1\n|hi\nEND\nDONE abc12345'],
    ['UNKNOWN_COMMAND', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN message\n|1\nEND\nBEGIN message\n|2\nEND\nBEGIN message\n|3\nEND\nBEGIN message\n|4\nEND\nBEGIN message\n|5\nEND\nDONE abc12345'],
  ])('rejects invalid protocol with %s', (code, text) => {
    expect(() => parser.parse(text)).toThrow(ChatReplyV1ParseError);
    try {
      parser.parse(text);
    } catch (error) {
      expect((error as ChatReplyV1ParseError).code).toBe(code);
    }
  });

  it('rejects the removed CONTENT section', () => {
    const legacy = [
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN message',
      'CONTENT',
      '|hi',
      'END',
      'DONE abc12345',
    ].join('\n');

    expect(() => parser.parse(legacy)).toThrow(expect.objectContaining({
      code: 'UNKNOWN_COMMAND',
      line: 4,
    }));
  });

  it('rejects no_reply with blocks and reply without blocks', () => {
    expect(() => parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION no_reply',
      'BEGIN message',
      '|hi',
      'END',
      'DONE abc12345',
    ].join('\n'))).toThrow(ChatReplyV1ParseError);

    expect(() => parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'DONE abc12345',
    ].join('\n'))).toThrow(ChatReplyV1ParseError);
  });
});
