export type TestStructuredReplyMessage =
  | { type: 'message'; content: string; [key: string]: unknown }
  | { type: 'structured_block'; content: string; [key: string]: unknown }
  | { type: 'image'; assetRef: string; alt: string; [key: string]: unknown }
  | { type: 'voice'; content: string; [key: string]: unknown }
  | { type: 'meme'; content: string; [key: string]: unknown };

export type TestStructuredReply = {
  decision: 'reply' | 'no_reply';
  outbound_messages: TestStructuredReplyMessage[] | null;
};

export interface TestStructuredReplyCapabilities {
  canVoice?: boolean;
  canMeme?: boolean;
}

export function nativeStructuredReplyEnvelope(
  reply: TestStructuredReply,
  capabilities: TestStructuredReplyCapabilities = {},
): Record<string, unknown> {
  const outbound = reply.outbound_messages ?? [];
  const voiceMessages = outbound.filter((message) => message.type === 'voice');
  const memeMessages = outbound.filter((message) => message.type === 'meme');
  const canVoice = capabilities.canVoice ?? (voiceMessages.length > 0);
  const canMeme = capabilities.canMeme ?? (memeMessages.length > 0);

  if (reply.decision === 'no_reply') {
    return {
      result: {
        decision: 'no_reply',
        messages: null,
        ...(canVoice ? { voice_message: null } : {}),
        ...(canMeme ? { meme_message: null } : {}),
      },
    };
  }

  if (voiceMessages.length > 1 || memeMessages.length > 1) {
    throw new Error('native structured reply fixture supports one voice and one meme slot.');
  }

  return {
    result: {
      decision: 'reply',
      messages: outbound.filter((message) => message.type !== 'voice' && message.type !== 'meme'),
      ...(canVoice ? { voice_message: voiceMessages[0] ?? null } : {}),
      ...(canMeme ? { meme_message: memeMessages[0] ?? null } : {}),
    },
  };
}

export function nativeStructuredReplyContent(
  reply: TestStructuredReply,
  capabilities: TestStructuredReplyCapabilities = {},
): string {
  return JSON.stringify(nativeStructuredReplyEnvelope(reply, capabilities));
}
