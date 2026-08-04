import { sanitizeStructuredReplyText } from '../../shared/outbound/index.js';
import type { ResolvedAction, StructuredReply, TurnContext } from './types.js';
import { GroupMemberMentionResolver } from './mention-resolver.js';
import type { Session } from 'koishi';
import { normalizeStructuredReplyForDelivery } from './normalizer.js';

export class ActionResolverService {
  constructor(private readonly mentionResolver = new GroupMemberMentionResolver()) {}

  async resolve(reply: StructuredReply, turnContext: TurnContext, session: Session): Promise<ResolvedAction[]> {
    const normalizedReply = normalizeStructuredReplyForDelivery(reply);
    if (normalizedReply.decision === 'no_reply') {
      return [{ kind: 'no_reply' }];
    }

    const messages = normalizedReply.outbound_messages ?? [];
    if (!messages.length) {
      throw new Error('structured reply with decision=reply must include at least one outbound message.');
    }

    const resolved: ResolvedAction[] = [];
    const capabilitySnapshot = turnContext.capabilitySnapshot;
    const canVoice = capabilitySnapshot?.canVoice === true;
    const canSticker = capabilitySnapshot?.canSticker === true;

    for (const message of messages) {
      if (message.type === 'voice') {
        const content = sanitizeStructuredReplyText(message.content, 'voice');
        if (!content) continue;
        if (!canVoice) {
          throw new Error('structured reply requested voice output but voice capability is unavailable.');
        }
        resolved.push({ kind: 'voice', content });
        continue;
      }

      if (message.type === 'meme') {
        const content = sanitizeStructuredReplyText(message.content, 'meme');
        if (!content) continue;
        if (!canSticker) {
          throw new Error('structured reply requested meme output but sticker capability is unavailable.');
        }
        resolved.push({ kind: 'sticker', intent: content });
        continue;
      }

      if (message.type === 'image') {
        const assetRef = message.assetRef.trim();
        const alt = sanitizeStructuredReplyText(message.alt, 'image_alt');
        if (!assetRef) continue;
        const authorizedImageAssetRefs = capabilitySnapshot?.imageAssetRefs ?? [];
        if (!authorizedImageAssetRefs.includes(assetRef)) {
          throw new Error('structured reply referenced an image that was not produced by this reply run.');
        }
        resolved.push({
          kind: 'image',
          assetRef,
          alt,
        });
        continue;
      }

      if (message.type === 'structured_block') {
        const content = sanitizeStructuredReplyText(message.content, 'structured_block');
        if (!content) continue;
        resolved.push({
          kind: 'structured_block',
          content,
        });
        continue;
      }

      const content = sanitizeStructuredReplyText(message.content, 'message');
      if (!content) {
        continue;
      }
      const parts = await this.mentionResolver.resolveInlineMentions(content, turnContext, session);

      resolved.push({
        kind: 'message',
        parts,
      });
    }

    if (!resolved.length) {
      throw new Error('structured reply resolved to an empty outbound plan.');
    }

    return resolved;
  }
}
