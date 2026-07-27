import { describe, expect, it } from 'vitest';
import {
  buildMemoryAddress,
  resolveCurrentMemoryAudience,
} from '../src/plugins/memory/address.js';

describe('memory address', () => {
  it('builds direct address by userKey and dm contextKey', () => {
    const address = buildMemoryAddress(
      {
        isDirect: true,
        platform: 'onebot',
        userId: '10001',
        channelId: 'dm-1',
        bot: { selfId: '20001' },
      } as any,
      {
        options: {
          conversation: {
            conversationId: 'conv-1',
            conversation: {
              id: 'conv-1',
            },
          },
        },
      },
      123,
    );
    expect(address).toMatchObject({
      userKey: 'onebot:user:10001',
      contextKey: 'onebot:bot:20001:dm:10001',
      channelType: 'direct',
      conversationId: 'conv-1',
      observedAt: 123,
    });
  });

  it('uses ChatLuna conversation resolution when legacy room data is absent', () => {
    const address = buildMemoryAddress(
      {
        isDirect: true,
        platform: 'onebot',
        userId: '10001',
        channelId: 'dm-1',
        bot: { selfId: '20001' },
      } as any,
      {
        options: {
          conversation: {
            conversationId: 'conv-effective',
            conversation: {
              id: 'conv-effective',
            },
          },
        },
      },
      789,
    );

    expect(address).toMatchObject({
      userKey: 'onebot:user:10001',
      contextKey: 'onebot:bot:20001:dm:10001',
      channelType: 'direct',
      conversationId: 'conv-effective',
      observedAt: 789,
    });
  });

  it('uses guildId then channelId fallback for group contextKey', () => {
    const address = buildMemoryAddress(
      {
        isDirect: false,
        platform: 'onebot',
        userId: '10001',
        channelId: 'channel-9',
        bot: { selfId: '20001' },
      } as any,
      {
        options: {
          conversation: {
            conversationId: 'conv-2',
            conversation: {
              id: 'conv-2',
            },
          },
        },
      },
      456,
    );
    expect(address).toMatchObject({
      userKey: 'onebot:user:10001',
      contextKey: 'onebot:bot:20001:group:channel-9',
      channelType: 'group',
      channelId: 'channel-9',
      rawContextId: 'channel-9',
    });
  });

  it('resolves an authoritative, complete group audience through the adapter', async () => {
    const session = {
      isDirect: false,
      platform: 'onebot',
      userId: '10001',
      guildId: 'group-9',
      channelId: 'group-9',
      bot: {
        selfId: '20001',
        getGuildMemberMap: async () => ({
          10003: 'Carol',
          10001: 'Alice',
          10002: 'Bob',
        }),
      },
    } as any;
    const base = buildMemoryAddress(session, {
      options: {
        conversation: {
          conversationId: 'conv-audience',
          conversation: { id: 'conv-audience' },
        },
      },
    }, 456);
    expect(base).not.toBeNull();
    await expect(resolveCurrentMemoryAudience(session, base!)).resolves.toMatchObject({
      currentAudienceSubjectKeys: [
        'onebot:user:10001',
        'onebot:user:10002',
        'onebot:user:10003',
      ],
    });
  });

  it('fails closed when the group audience cannot be proven', async () => {
    const session = {
      isDirect: false,
      platform: 'onebot',
      userId: '10001',
      guildId: 'group-9',
      channelId: 'group-9',
      bot: {
        selfId: '20001',
        getGuildMemberMap: async () => {
          throw new Error('adapter unavailable');
        },
      },
    } as any;
    const base = buildMemoryAddress(session, {
      options: {
        conversation: {
          conversationId: 'conv-audience',
          conversation: { id: 'conv-audience' },
        },
      },
    }, 456);
    await expect(resolveCurrentMemoryAudience(session, base!)).rejects.toMatchObject({
      code: 'memory_group_audience_unavailable',
      operation: 'address',
      stage: 'provider',
    });
  });
});
