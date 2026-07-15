import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AIMessage, FunctionMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { resolveChatlunaSiblingPackageRoot } from './helpers/chatluna-paths.js';

vi.mock('koishi', () => ({
  Context: class {},
  Session: class {},
  Time: {},
  Logger: class {
    warn(...args: unknown[]) {
      console.warn(...args);
    }
  },
  Schema: {
    object: () => ({}),
    boolean: () => ({}),
    string: () => ({}),
    natural: () => ({}),
    number: () => ({}),
    array: () => ({}),
    union: () => ({}),
    const: () => ({}),
  },
  h: {
    parse: () => [],
    text: (content: string) => content,
  },
}));

vi.mock('koishi-plugin-chatluna/utils/string', () => ({
  getImageMimeType: () => 'image/jpeg',
  getMimeTypeFromSource: () => 'image/jpeg',
  isMessageContentImageUrl: (value: unknown) =>
    typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'image_url',
}));

vi.mock('koishi-plugin-chatluna', () => ({
  Config: class {},
  ConversationRoom: class {},
  logger: { warn: vi.fn() },
}));

vi.mock('koishi-plugin-chatluna/llm-core/utils/count_tokens', () => ({
  resolveModelContextSize: () => 128_000,
}));

vi.mock('koishi-plugin-chatluna/services/chat', () => ({
  ChatLunaPlugin: class {},
}));

type LangchainMessageToResponseInput = (
  messages: unknown[],
  plugin: unknown,
  model?: string,
  supportImageInput?: boolean,
) => Promise<unknown[]>;

type ResponsesUtilsModule = {
  langchainMessageToResponseInput: LangchainMessageToResponseInput;
};

async function loadResponsesUtils(): Promise<ResponsesUtilsModule> {
  const moduleUrl = pathToFileURL(join(process.cwd(), '..', 'chatluna', 'packages', 'shared-adapter', 'src', 'utils.js')).href;
  return import(moduleUrl) as Promise<ResponsesUtilsModule>;
}

describe('chatluna responses input regression', () => {
  it('serializes assistant history as text and user arrays as input content', async () => {
    const { langchainMessageToResponseInput } = await loadResponsesUtils();
    const input = await langchainMessageToResponseInput(
      [
        new HumanMessage({ content: [{ type: 'text', text: 'hello' }] }),
        new AIMessage({ content: [{ type: 'text', text: 'hi' }] }),
      ],
      {} as never,
    );

    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'hi',
      },
    ]);
  });

  it('keeps assistant transport media out of Responses history', async () => {
    const { langchainMessageToResponseInput } = await loadResponsesUtils();
    const plugin = { fetch: vi.fn() };
    const input = await langchainMessageToResponseInput(
      [
        new AIMessage({
          content: [
            { type: 'text', text: '机器人返回了课程卡片。' },
            { type: 'image_url', image_url: { url: 'https://storage.example/card.png' } },
            { type: 'file_url', file_url: { url: 'https://storage.example/result.pdf' } },
            { type: 'audio_url', audio_url: { url: 'https://storage.example/result.mp3' } },
          ],
        }),
        new AIMessage({
          content: [
            { type: 'image_url', image_url: { url: 'https://storage.example/image-only.png' } },
          ],
        }),
        new HumanMessage('继续'),
      ],
      plugin,
      'gpt-5.4',
      true,
    );

    expect(input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: '机器人返回了课程卡片。',
      },
      {
        type: 'message',
        role: 'user',
        content: '继续',
      },
    ]);
    expect(plugin.fetch).not.toHaveBeenCalled();
  });

  it('preserves supported user image and file inputs', async () => {
    const { langchainMessageToResponseInput } = await loadResponsesUtils();
    const input = await langchainMessageToResponseInput(
      [
        new HumanMessage({
          content: [
            { type: 'text', text: '查看附件' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
            { type: 'file_url', file_url: { url: 'https://storage.example/guide.pdf', filename: 'guide.pdf' } },
          ],
        }),
      ],
      {},
      'gpt-5.4',
      true,
    );

    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '查看附件' },
          { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'auto' },
          {
            type: 'input_file',
            file_url: 'https://storage.example/guide.pdf',
            filename: 'guide.pdf',
          },
        ],
      },
    ]);
  });

  it('drops empty unsupported input content and emits legacy function messages once', async () => {
    const { langchainMessageToResponseInput } = await loadResponsesUtils();
    const input = await langchainMessageToResponseInput(
      [
        new FunctionMessage({ content: '函数结果', name: 'legacy_lookup' }),
        new HumanMessage({
          content: [
            { type: 'audio_url', audio_url: { url: 'https://storage.example/input.mp3' } },
          ],
        }),
        new HumanMessage('继续'),
      ],
      {},
      'gpt-5.4',
      true,
    );

    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: '函数结果',
      },
      {
        type: 'message',
        role: 'user',
        content: '继续',
      },
    ]);
  });

  it('keeps only valid function call and tool output pairs in responses mode', async () => {
    const { langchainMessageToResponseInput } = await loadResponsesUtils();
    const paired = await langchainMessageToResponseInput(
      [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'tool-1', name: 'search', args: { q: 'liquid glass' }, type: 'tool_call' }],
        }),
        new ToolMessage({ content: '搜索结果', name: 'search', tool_call_id: 'tool-1' }),
      ],
      {} as never,
    );

    expect(paired).toEqual([
      {
        type: 'function_call',
        call_id: 'tool-1',
        name: 'search',
        arguments: '{"q":"liquid glass"}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'tool-1',
        output: '搜索结果',
      },
    ]);
  });

  it('uses the single real assistant tool call as the only fallback for missing tool_call_id', async () => {
    const { langchainMessageToResponseInput } = await loadResponsesUtils();
    const recovered = await langchainMessageToResponseInput(
      [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'tool-1', name: 'search', args: { q: 'sakiko' }, type: 'tool_call' }],
        }),
        new ToolMessage({ content: '唯一候选', name: 'search', tool_call_id: undefined as never }),
      ],
      {} as never,
    );

    const dropped = await langchainMessageToResponseInput(
      [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 'tool-1', name: 'search', args: { q: 'a' }, type: 'tool_call' },
            { id: 'tool-2', name: 'search', args: { q: 'b' }, type: 'tool_call' },
          ],
        }),
        new ToolMessage({ content: '不应猜测', name: 'search', tool_call_id: undefined as never }),
      ],
      {} as never,
    );

    expect(recovered).toEqual([
      {
        type: 'function_call',
        call_id: 'tool-1',
        name: 'search',
        arguments: '{"q":"sakiko"}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'tool-1',
        output: '唯一候选',
      },
    ]);
    expect(dropped).toEqual([
      {
        type: 'function_call',
        call_id: 'tool-1',
        name: 'search',
        arguments: '{"q":"a"}',
        status: 'completed',
      },
      {
        type: 'function_call',
        call_id: 'tool-2',
        name: 'search',
        arguments: '{"q":"b"}',
        status: 'completed',
      },
    ]);
  });

  it('drops orphan tool outputs whose call ids were not emitted in the request', async () => {
    const { langchainMessageToResponseInput } = await loadResponsesUtils();
    const input = await langchainMessageToResponseInput(
      [
        new ToolMessage({ content: '孤儿结果', name: 'search', tool_call_id: 'tool-orphan' }),
      ],
      {} as never,
    );

    expect(input).toEqual([]);
  });

  it('keeps responses-mode multimodal content mapped to input_* item types', () => {
    const sharedAdapterRoot = resolveChatlunaSiblingPackageRoot('shared-adapter');
    const sharedAdapterSource = readFileSync(join(sharedAdapterRoot, 'src', 'utils.ts'), 'utf8');
    const sharedAdapterRequesterSource = readFileSync(join(sharedAdapterRoot, 'src', 'requester.ts'), 'utf8');
    const sharedAdapterBundle = readFileSync(join(sharedAdapterRoot, 'lib', 'index.mjs'), 'utf8');

    expect(sharedAdapterSource).toContain('responseInputContent');
    expect(sharedAdapterSource).toContain("type: 'input_image'");
    expect(sharedAdapterRequesterSource).toContain('langchainMessageToResponseInput');

    expect(sharedAdapterBundle).toContain('responseInputContent');
    expect(sharedAdapterBundle).toContain('type: "input_image"');
    expect(sharedAdapterBundle).toContain('langchainMessageToResponseInput');
    expect(sharedAdapterSource).toContain('resolveResponseToolOutputCallIds');
    expect(sharedAdapterBundle).toContain('resolveResponseToolOutputCallIds');
  });
});
