import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  h: {
    parse: () => [],
  },
}));
import {
  createReplyFinalizerToolEntry,
  ReplyFinalizerRequestRegistry,
  ReplyFinalizerTool,
} from '../src/plugins/reply/finalizer/tool.js';
import { ChatReplyV1Parser } from '../src/plugins/reply/pipeline/chat-reply-v1.js';

function runnableConfig(requestId: string, kind: 'main' | 'subagent' = 'main') {
  return {
    configurable: {
      agentContext: { requestId, kind },
    },
  } as never;
}

function textEnvelope(content = '收到。') {
  return {
    result: {
      decision: 'reply' as const,
      messages: [{ type: 'message' as const, content }],
      voice_message: null,
      meme_message: null,
    },
  };
}

describe('reply finalizer tool', () => {
  it('returns a direct, compiler-compatible protocol only for an active main request', async () => {
    const registry = new ReplyFinalizerRequestRegistry();
    registry.begin('request-1', {
      canVoice: false,
      canMeme: false,
      explicitVoiceRequested: false,
      explicitMemeRequested: false,
      hasImageAssetRef: () => false,
    });
    const tool = new ReplyFinalizerTool(registry);

    const result = await tool._call(textEnvelope('好，我知道了。'), undefined, runnableConfig('request-1'));

    expect(result.lc_direct_tool_output).toBe(true);
    expect(new ChatReplyV1Parser().parse(result.output)).toEqual({
      decision: 'reply',
      outbound_messages: [{ type: 'message', content: '好，我知道了。' }],
    });
  });

  it('rejects unavailable or omitted explicitly requested modalities before termination', async () => {
    const registry = new ReplyFinalizerRequestRegistry();
    registry.begin('request-sticker', {
      canVoice: false,
      canMeme: true,
      explicitVoiceRequested: false,
      explicitMemeRequested: true,
      hasImageAssetRef: () => false,
    });
    const tool = new ReplyFinalizerTool(registry);

    await expect(
      tool._call(textEnvelope(), undefined, runnableConfig('request-sticker')),
    ).rejects.toThrow('explicitly requested a sticker');

    registry.begin('request-text', {
      canVoice: false,
      canMeme: false,
      explicitVoiceRequested: false,
      explicitMemeRequested: false,
      hasImageAssetRef: () => false,
    });
    await expect(
      tool._call({
        result: {
          decision: 'reply',
          messages: [],
          voice_message: { type: 'voice', content: '听我说。' },
          meme_message: null,
        },
      }, undefined, runnableConfig('request-text')),
    ).rejects.toThrow('voice_message is unavailable');
  });

  it('rejects impossible explicit-modality contracts before an Agent loop starts', () => {
    const registry = new ReplyFinalizerRequestRegistry();
    expect(() => registry.begin('request-impossible-voice', {
      canVoice: false,
      canMeme: false,
      explicitVoiceRequested: true,
      explicitMemeRequested: false,
      hasImageAssetRef: () => false,
    })).toThrow('explicit voice intent must be permitted');
    expect(() => registry.begin('request-impossible-sticker', {
      canVoice: false,
      canMeme: false,
      explicitVoiceRequested: false,
      explicitMemeRequested: true,
      hasImageAssetRef: () => false,
    })).toThrow('explicit sticker intent must be permitted');
  });

  it('keeps the terminal call open for retry when content is not deliverable', async () => {
    const registry = new ReplyFinalizerRequestRegistry();
    registry.begin('request-empty', {
      canVoice: false,
      canMeme: false,
      explicitVoiceRequested: false,
      explicitMemeRequested: false,
      hasImageAssetRef: () => false,
    });
    const tool = new ReplyFinalizerTool(registry);

    await expect(
      tool._call(textEnvelope('   '), undefined, runnableConfig('request-empty')),
    ).rejects.toThrow();
    await expect(
      tool._call(textEnvelope('[CQ:at,qq=123]'), undefined, runnableConfig('request-empty')),
    ).rejects.toThrow('requires user-visible content');
  });

  it('is selected only for a marked current human turn and refuses subagents', async () => {
    const entry = createReplyFinalizerToolEntry(new ReplyFinalizerRequestRegistry());
    expect(entry.selector([
      new HumanMessage({ content: 'ordinary turn' }),
    ])).toBe(false);
    expect(entry.selector([
      new HumanMessage({
        content: 'reply turn',
        additional_kwargs: {
          qqbot_final_response_contract: {
            terminalTool: 'qqbot_submit_reply',
          },
        },
      }),
    ])).toBe(true);

    const registry = new ReplyFinalizerRequestRegistry();
    registry.begin('request-subagent', {
      canVoice: false,
      canMeme: false,
      explicitVoiceRequested: false,
      explicitMemeRequested: false,
      hasImageAssetRef: () => false,
    });
    await expect(
      new ReplyFinalizerTool(registry)._call(
        textEnvelope(),
        undefined,
        runnableConfig('request-subagent', 'subagent'),
      ),
    ).rejects.toThrow('available only to the main Agent');
  });

  it('accepts only image artifacts owned by the current reply run', async () => {
    const registry = new ReplyFinalizerRequestRegistry();
    registry.begin('request-image-1', {
      canVoice: false,
      canMeme: false,
      explicitVoiceRequested: false,
      explicitMemeRequested: false,
      hasImageAssetRef: (assetRef) => assetRef === 'asset:run-1:chart',
    });
    registry.begin('request-image-2', {
      canVoice: false,
      canMeme: false,
      explicitVoiceRequested: false,
      explicitMemeRequested: false,
      hasImageAssetRef: (assetRef) => assetRef === 'asset:run-2:chart',
    });
    const tool = new ReplyFinalizerTool(registry);
    const imageEnvelope = (assetRef: string) => ({
      result: {
        decision: 'reply' as const,
        messages: [{ type: 'image' as const, assetRef, alt: 'rating chart' }],
        voice_message: null,
        meme_message: null,
      },
    });

    const accepted = await tool._call(
      imageEnvelope('asset:run-1:chart'),
      undefined,
      runnableConfig('request-image-1'),
    );
    expect(new ChatReplyV1Parser().parse(accepted.output)).toEqual({
      decision: 'reply',
      outbound_messages: [{
        type: 'image',
        assetRef: 'asset:run-1:chart',
        alt: 'rating chart',
      }],
    });
    await expect(
      tool._call(
        imageEnvelope('asset:forged'),
        undefined,
        runnableConfig('request-image-1'),
      ),
    ).rejects.toThrow('image assetRef is unavailable');
    await expect(
      tool._call(
        imageEnvelope('asset:run-1:chart'),
        undefined,
        runnableConfig('request-image-2'),
      ),
    ).rejects.toThrow('image assetRef is unavailable');
  });
});
