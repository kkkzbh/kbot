import { sanitizeStructuredReplyText } from '../../shared/outbound/index.js';
import type { StructuredReply, StructuredReplyMessage } from './types.js';

export class StructuredReplyDeliverabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredReplyDeliverabilityError';
  }
}

function normalizeMessage(message: StructuredReplyMessage): StructuredReplyMessage {
  if (message.type === 'image') {
    const assetRef = message.assetRef.trim();
    const alt = sanitizeStructuredReplyText(message.alt, 'image_alt');
    if (!assetRef || !alt) {
      throw new StructuredReplyDeliverabilityError('image requires a usable assetRef and alt text.');
    }
    return { ...message, assetRef, alt };
  }

  const kind = message.type === 'meme' ? 'meme' : message.type;
  const content = sanitizeStructuredReplyText(message.content, kind);
  if (!content) {
    throw new StructuredReplyDeliverabilityError(`${message.type} requires user-visible content.`);
  }
  return { ...message, content };
}

export function normalizeStructuredReplyForDelivery(reply: StructuredReply): StructuredReply {
  if (reply.decision === 'no_reply') {
    return { decision: 'no_reply', outbound_messages: null };
  }

  const messages = reply.outbound_messages?.map(normalizeMessage) ?? [];
  if (messages.length < 1 || messages.length > 4) {
    throw new StructuredReplyDeliverabilityError('reply requires one to four deliverable messages.');
  }

  return {
    decision: 'reply',
    outbound_messages: messages,
  };
}
