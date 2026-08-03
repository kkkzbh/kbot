import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  h: {
    parse: () => [],
  },
}));

import type { ReplyOutputProtocol } from '../src/plugins/shared/llm/reply-output-contract.js';
import { encodeChatReplyV1 } from '../src/plugins/reply/pipeline/chat-reply-v1.js';
import { ReplyOrchestratorService } from '../src/plugins/reply/pipeline/orchestrator.js';
import type { StructuredReply, StructuredReplyMessage } from '../src/plugins/reply/pipeline/types.js';
import { nativeStructuredReplyContent } from './structured-reply-fixture.js';

function createTurnInput(text: string, scenarioName: string) {
  const scenarioId = scenarioName.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
  return {
    text,
    imageParts: [],
    hasImageInput: false,
    imageCount: 0,
    hasVoiceInput: false,
    displayName: '小祥',
    userId: `u-${scenarioId}`,
    isDirect: false,
    messageId: `msg-${scenarioId}`,
    conversationId: `conv-cf-first-${scenarioId}`,
  };
}

function createModelResponse(reply: StructuredReply, outputProtocol: ReplyOutputProtocol | undefined) {
  if (outputProtocol === 'chat_reply_v1') {
    return {
      content: encodeChatReplyV1(reply, 'cfcase01'),
    };
  }

  return {
    content: nativeStructuredReplyContent(reply),
  };
}

type CfReplyScenario = {
  name: string;
  input: string;
  outputProtocol?: ReplyOutputProtocol;
  image: Extract<StructuredReplyMessage, { type: 'image' }>;
  evaluation: string;
};

const cfReplyScenarios: CfReplyScenario[] = [
  {
    name: 'direct profile command in a group',
    input: 'saki /cf liuliu00',
    image: {
      type: 'image',
      assetRef: 'asset:tool:cf-profile:liuliu00',
      alt: 'liuliu00 的 Codeforces 分数卡',
    },
    evaluation: 'liuliu00 现在是 896 的 newbie，刚起步，先把基础题量堆起来更实际。',
  },
  {
    name: 'rating chart command through CHAT_REPLY_V1',
    input: '@小祥 /cf ./rating liuliu00',
    outputProtocol: 'chat_reply_v1',
    image: {
      type: 'image',
      assetRef: 'asset:tool:cf-rating:liuliu00',
      alt: 'liuliu00 的 Codeforces rating 历史图',
    },
    evaluation: 'liuliu00 的曲线样本还很少，当前和最高分都在 896，先稳定参赛比急着冲分重要。',
  },
  {
    name: 'natural rating lookup after contest talk',
    input: '刚才说到涨分，祥帮我 /cf ./rating tourist 看看曲线',
    image: {
      type: 'image',
      assetRef: 'asset:tool:cf-rating:tourist',
      alt: 'tourist 的 Codeforces rating 历史图',
    },
    evaluation: 'tourist 的曲线长期站在顶端，波动更多是高分段竞争强度，不是实力不稳。',
  },
  {
    name: 'implicit profile lookup in noisy context',
    input: '不打岔了，顺手 cf YingCir 现在什么水平',
    image: {
      type: 'image',
      assetRef: 'asset:tool:cf-profile:YingCir',
      alt: 'YingCir 的 Codeforces 分数卡',
    },
    evaluation: 'YingCir 目前是 1015 的 newbie，说明已经入门，但训练重心还应该放在 800 到 1200 的稳定 AC。',
  },
  {
    name: 'model orders text before image and runtime preserves that order',
    input: '他吹自己红名，/cf Petr 要图也要评价一下',
    image: {
      type: 'image',
      assetRef: 'asset:tool:cf-profile:Petr',
      alt: 'Petr 的 Codeforces 分数卡',
    },
    evaluation: 'Petr 的历史高度不用怀疑，红名级别更多是在考验长期比赛状态和题感维护。',
  },
];

describe('/cf reply scenarios', () => {
  it.each(cfReplyScenarios)('returns image plus evaluation for $name', async (scenario) => {
    const orchestrator = new ReplyOrchestratorService();
    const outboundMessages: StructuredReplyMessage[] =
      scenario.name === 'model orders text before image and runtime preserves that order'
        ? [
            { type: 'message', content: scenario.evaluation },
            scenario.image,
          ]
        : [
            scenario.image,
            { type: 'message', content: scenario.evaluation },
          ];
    const reply: StructuredReply = {
      decision: 'reply',
      outbound_messages: outboundMessages,
    };

    const ready = await orchestrator.handle(createTurnInput(scenario.input, scenario.name), {} as never, {
      routeHint: 'agent',
      outputProtocol: scenario.outputProtocol,
      capabilitySnapshot: {
        canMultiline: true,
        canVoice: false,
        canSticker: false,
        stickerAvailableCount: 0,
        imageAssetRefs: [scenario.image.assetRef],
        source: 'test',
      },
      responseMessage: createModelResponse(reply, scenario.outputProtocol),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }

    expect(ready.actions).toEqual(outboundMessages.map((message) => (
      message.type === 'image'
        ? { kind: 'image', assetRef: message.assetRef, alt: message.alt }
        : { kind: 'message', parts: [{ kind: 'text', content: message.content }] }
    )));
  });
});
