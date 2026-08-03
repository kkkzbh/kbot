import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODALITY_PREFERENCE,
  ModalityDirector,
  deriveModalityPolicy,
  isExplicitVoiceRequest,
  type ModalityPreferenceSnapshot,
  type ModalityTransportCapabilities,
} from '../src/plugins/reply/modality/director.js';
import type { TurnInput } from '../src/plugins/reply/pipeline/types.js';

const transport: ModalityTransportCapabilities = {
  canVoice: true,
  canSticker: true,
  stickerAvailableCount: 8,
};

const defaultPreference: ModalityPreferenceSnapshot = { ...DEFAULT_MODALITY_PREFERENCE };

function input(text: string, options: Partial<TurnInput> = {}): TurnInput {
  const { imageParts = [], ...inputOptions } = options;
  return {
    text,
    hasImageInput: false,
    imageCount: 0,
    hasVoiceInput: false,
    displayName: '小祥',
    userId: 'user-1',
    isDirect: true,
    conversationId: 'conversation-1',
    ...inputOptions,
    imageParts,
  };
}

describe('modality director', () => {
  it('admits private social voice but keeps the same group message in text', () => {
    const privatePolicy = deriveModalityPolicy(input('晚安，我今天好累'), transport, {
      stickerReady: true,
      voiceReady: true,
    }, defaultPreference);
    const groupPolicy = deriveModalityPolicy(
      input('晚安，我今天好累', { isDirect: false }),
      transport,
      { stickerReady: true, voiceReady: true },
      defaultPreference,
    );

    expect(privatePolicy.canVoice).toBe(true);
    expect(privatePolicy.voiceReason).toBe('private_social_moment');
    expect(groupPolicy.canVoice).toBe(false);
    expect(groupPolicy.voiceReason).toBe('not_admitted');
  });

  it('honors explicit voice and sticker requests when transport supports them', () => {
    const policy = deriveModalityPolicy(input('用语音回我，再来个表情包'), transport, {
      stickerReady: false,
      voiceReady: false,
    }, defaultPreference);

    expect(policy).toMatchObject({
      canVoice: true,
      voiceReason: 'explicit_request',
      canSticker: true,
      stickerReason: 'explicit_request',
    });
  });

  it('recognizes common imperative voice and sticker wording', () => {
    const voiceRequests = [
      '请只发一句语音',
      '用语音说收到，再补一句',
      '用语音说说我的性格',
      '我有点睡不着，给我发一小段语音说晚安。',
    ];
    const stickerRequests = [
      '配一个表情包',
      '发个表情包',
      '请发一张贴图',
    ];

    for (const text of voiceRequests) {
      const policy = deriveModalityPolicy(
        input(text),
        transport,
        { stickerReady: true, voiceReady: true },
        defaultPreference,
      );
      expect(policy.voiceReason, text).toBe('explicit_request');
      expect(policy.canVoice, text).toBe(true);
      expect(isExplicitVoiceRequest(text), text).toBe(true);
    }
    for (const text of stickerRequests) {
      const policy = deriveModalityPolicy(
        input(text),
        transport,
        { stickerReady: true, voiceReady: true },
        defaultPreference,
      );
      expect(policy.stickerReason, text).toBe('explicit_request');
      expect(policy.canSticker, text).toBe(true);
    }
  });

  it('abstains from stickers for serious and informational requests', () => {
    const serious = deriveModalityPolicy(input('朋友说不想活了，我该怎么办'), transport, {
      stickerReady: true,
      voiceReady: true,
    }, defaultPreference);
    const informational = deriveModalityPolicy(input('帮我分析这个报错是什么'), transport, {
      stickerReady: true,
      voiceReady: true,
    }, defaultPreference);

    expect(serious.canSticker).toBe(false);
    expect(serious.stickerReason).toBe('not_admitted');
    expect(informational.canSticker).toBe(false);
    expect(informational.stickerReason).toBe('not_admitted');
  });

  it('admits a voice reply after voice input in both private and group conversations', () => {
    for (const isDirect of [true, false]) {
      const policy = deriveModalityPolicy(
        input('收到啦', { isDirect, hasVoiceInput: true }),
        transport,
        { stickerReady: true, voiceReady: false },
        defaultPreference,
      );
      expect(policy.canVoice).toBe(true);
      expect(policy.voiceReason).toBe('voice_reply');
    }
  });

  it('starts cooldown only after a modality is actually delivered', () => {
    const director = new ModalityDirector({ stickerCooldownTurns: 3 });

    const first = director.beginTurn({
      turnId: 'turn-1',
      conversationKey: 'conversation-1',
      input: input('哈哈太离谱了'),
      transport,
      preference: defaultPreference,
    });
    expect(first.canSticker).toBe(true);
    director.finishTurn('turn-1');

    const unsentFollowup = director.beginTurn({
      turnId: 'turn-2',
      conversationKey: 'conversation-1',
      input: input('哈哈太离谱了'),
      transport,
      preference: defaultPreference,
    });
    expect(unsentFollowup.canSticker).toBe(true);
    director.recordDelivered('turn-2', 'sticker');
    director.finishTurn('turn-2');

    for (let turn = 3; turn <= 5; turn += 1) {
      const policy = director.beginTurn({
        turnId: `turn-${turn}`,
        conversationKey: 'conversation-1',
        input: input('哈哈太离谱了'),
        transport,
        preference: defaultPreference,
      });
      expect(policy.canSticker).toBe(false);
      director.finishTurn(`turn-${turn}`);
    }

    const afterCooldown = director.beginTurn({
      turnId: 'turn-6',
      conversationKey: 'conversation-1',
      input: input('哈哈太离谱了'),
      transport,
      preference: defaultPreference,
    });
    expect(afterCooldown.canSticker).toBe(true);
  });

  it('does not treat informational modality mentions as current requests', () => {
    const cases = [
      '语音消息是什么格式',
      '怎么发语音比较清楚',
      'QQ 可以发语音吗',
      '这里可以发表情包吗',
      '帮我找几个表情包制作教程',
    ];

    for (const text of cases) {
      const policy = deriveModalityPolicy(
        input(text),
        transport,
        { stickerReady: true, voiceReady: true },
        defaultPreference,
      );
      expect(policy.canVoice).toBe(false);
      expect(policy.canSticker).toBe(false);
    }
  });

  it('does not admit a sticker from the bare exclamation 救命', () => {
    const policy = deriveModalityPolicy(
      input('救命，我又忘带钥匙了'),
      transport,
      { stickerReady: true, voiceReady: true },
      defaultPreference,
    );

    expect(policy.canSticker).toBe(false);
    expect(policy.stickerReason).toBe('not_admitted');
  });

  it('suppresses automatic modalities after a stored preference', () => {
    const preference: ModalityPreferenceSnapshot = {
      voiceAutomatic: false,
      stickerAutomatic: false,
    };
    const social = deriveModalityPolicy(
      input('晚安，我今天好累'),
      transport,
      { stickerReady: true, voiceReady: true },
      preference,
    );
    const casual = deriveModalityPolicy(
      input('哈哈太离谱了'),
      transport,
      { stickerReady: true, voiceReady: true },
      preference,
    );
    const voiceReply = deriveModalityPolicy(
      input('收到', { hasVoiceInput: true }),
      transport,
      { stickerReady: true, voiceReady: true },
      preference,
    );

    expect(social.canVoice).toBe(false);
    expect(casual.canSticker).toBe(false);
    expect(voiceReply.canVoice).toBe(false);
  });

  it('lets an explicit current request override automatic preferences for that turn', () => {
    const preference: ModalityPreferenceSnapshot = {
      voiceAutomatic: false,
      stickerAutomatic: false,
    };
    const policy = deriveModalityPolicy(
      input('能不能给我发一段语音，再来个表情包'),
      transport,
      { stickerReady: false, voiceReady: false },
      preference,
    );

    expect(policy).toMatchObject({
      canVoice: true,
      voiceReason: 'explicit_request',
      canSticker: true,
      stickerReason: 'explicit_request',
    });
    expect(preference).toEqual({
      voiceAutomatic: false,
      stickerAutomatic: false,
    });
  });
});
