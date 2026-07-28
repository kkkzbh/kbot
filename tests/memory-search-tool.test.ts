import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerMemorySearchTool,
  type MemorySearchToolRegistry,
} from '../src/plugins/memory/tool.js';
import type { MemoryStatusService } from '../src/plugins/memory/status.js';
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types';
import {
  assertion,
  closeMemoryV3TestRuntime,
  createMemoryV3TestRuntime,
  type MemoryV3TestRuntime,
} from './memory-v3-runtime.js';

const runtimes: MemoryV3TestRuntime[] = [];

async function runtime(): Promise<MemoryV3TestRuntime> {
  const value = await createMemoryV3TestRuntime();
  runtimes.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(closeMemoryV3TestRuntime));
});

function session(members = ['10001', '10002']) {
  return {
    userId: '10001',
    platform: 'onebot',
    isDirect: false,
    guildId: 'group-b',
    channelId: 'group-b',
    selfId: 'bot',
    bot: {
      selfId: 'bot',
      getGuildMemberMap: vi.fn(async () => Object.fromEntries(
        members.map((id) => [id, id]),
      )),
    },
  };
}

function toolConfig(
  kind: 'main' | 'automation' | 'subagent',
  requestId: string,
  members = ['10001', '10002'],
) {
  return {
    configurable: {
      model: {},
      session: session(members),
      conversationId: 'conversation:group-b',
      agentContext: {
        kind,
        requestId,
        conversationId: 'conversation:group-b',
      },
    },
  };
}

function createTool(
  store: MemoryV3TestRuntime['store'],
  runtime = {
    enabled: true,
    maintenance: false,
    readEnabled: true,
  },
): {
  tool: ReturnType<ChatLunaTool['createTool']>;
  status: {
    recordSearch: ReturnType<typeof vi.fn>;
    recordRejectedSearch: ReturnType<typeof vi.fn>;
  };
} {
  let createRegisteredTool: ChatLunaTool['createTool'] | undefined;
  const registry: MemorySearchToolRegistry = {
    registerTool: (_name, value) => {
      createRegisteredTool = value.createTool;
      return () => undefined;
    },
  };
  const status = {
    recordSearch: vi.fn(),
    recordRejectedSearch: vi.fn(),
  };
  registerMemorySearchTool(
    registry,
    store,
    status as unknown as MemoryStatusService,
    runtime,
  );
  if (!createRegisteredTool) throw new Error('memory_search was not registered');
  return { tool: createRegisteredTool({} as never), status };
}

describe('memory_search Tool', () => {
  it('returns only public verified fields for main Agent and Automation', async () => {
    const { store } = await runtime();
    await store.appendAssertion(assertion());
    const { tool, status } = createTool(store);

    for (const kind of ['main', 'automation'] as const) {
      const raw = await tool.invoke(
        { mode: 'search', query: '古典', limit: 5 },
        toolConfig(kind, `request:${kind}`) as never,
      );
      const result = JSON.parse(String(raw)) as {
        trust: string;
        returned: number;
        items: Array<Record<string, unknown>>;
      };
      expect(result.trust).toBe('untrusted_historical_reference');
      expect(result.returned).toBe(1);
      expect(result.items[0]).toMatchObject({
        type: 'userAssertion',
        kind: 'preference',
        topic: 'music',
        subject: '当前用户',
        statement: '小祥喜欢古典音乐。',
        visibility: '共同成员群聊可见',
      });
      expect(JSON.stringify(result)).not.toMatch(
        /onebot:|streamId|messageId|evidence|group-b/u,
      );
    }
    expect(status.recordSearch).toHaveBeenCalledTimes(2);
  });

  it('rejects Sub-Agent, forged cursor and a new group member', async () => {
    const { store } = await runtime();
    await store.appendAssertion(assertion());
    const { tool, status } = createTool(store);

    await expect(tool.invoke(
      { mode: 'recent', limit: 1 },
      toolConfig('subagent', 'request:subagent') as never,
    )).rejects.toMatchObject({ code: 'memory_tool_subagent_forbidden' });
    await expect(tool.invoke(
      { mode: 'recent', limit: 1, cursor: crypto.randomUUID() },
      toolConfig('main', 'request:cursor') as never,
    )).rejects.toMatchObject({ code: 'memory_tool_cursor_invalid' });

    const raw = await tool.invoke(
      { mode: 'recent', limit: 5 },
      toolConfig('main', 'request:new-member', ['10001', '10002', '10003']) as never,
    );
    expect(JSON.parse(String(raw))).toMatchObject({ returned: 0, items: [] });
    expect(status.recordRejectedSearch).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid time ranges and missing request identity', async () => {
    const { store } = await runtime();
    const { tool, status } = createTool(store);
    await expect(tool.invoke(
      {
        mode: 'recent',
        from: '2026-07-29T00:00:00Z',
        to: '2026-07-28T00:00:00Z',
      },
      toolConfig('main', 'request:time') as never,
    )).rejects.toMatchObject({ code: 'memory_tool_time_range_invalid' });
    const missingRequest = toolConfig('main', 'request:missing');
    delete (missingRequest.configurable.agentContext as { requestId?: string }).requestId;
    await expect(tool.invoke(
      { mode: 'recent' },
      missingRequest as never,
    )).rejects.toMatchObject({ code: 'memory_tool_request_identity_missing' });
    expect(status.recordRejectedSearch).toHaveBeenCalledTimes(2);
  });

  it('enforces the live read and maintenance gates inside the Tool', async () => {
    const { store } = await runtime();
    for (const state of [
      { enabled: true, maintenance: false, readEnabled: false },
      { enabled: true, maintenance: true, readEnabled: true },
    ]) {
      const { tool, status } = createTool(store, state);
      await expect(tool.invoke(
        { mode: 'recent' },
        toolConfig('main', `request:runtime:${JSON.stringify(state)}`) as never,
      )).rejects.toMatchObject({ code: 'memory_tool_unavailable' });
      expect(status.recordRejectedSearch).toHaveBeenCalledOnce();
    }
  });

  it('enforces five calls per request and keeps cursors request-scoped', async () => {
    const { store } = await runtime();
    for (let index = 0; index < 3; index += 1) {
      await store.appendAssertion(assertion({
        idempotencyKey: `tool:${index}`,
        topicKey: `topic:${index}`,
        content: `记忆 ${index}`,
        retrievalText: `记忆 ${index}`,
      }));
    }
    const { tool } = createTool(store);
    const first = JSON.parse(String(await tool.invoke(
      { mode: 'recent', limit: 1 },
      toolConfig('main', 'request:paged') as never,
    ))) as { nextCursor: string };
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(tool.invoke(
      { mode: 'recent', limit: 1, cursor: first.nextCursor },
      toolConfig('main', 'request:other') as never,
    )).rejects.toMatchObject({ code: 'memory_tool_cursor_invalid' });

    for (let index = 0; index < 4; index += 1) {
      await tool.invoke(
        { mode: 'search', query: '记忆', limit: 1 },
        toolConfig('automation', 'request:budget') as never,
      );
    }
    await tool.invoke(
      { mode: 'recent', limit: 1 },
      toolConfig('automation', 'request:budget') as never,
    );
    await expect(tool.invoke(
      { mode: 'recent', limit: 1 },
      toolConfig('automation', 'request:budget') as never,
    )).rejects.toMatchObject({ code: 'memory_tool_call_budget_exceeded' });
  });
});
