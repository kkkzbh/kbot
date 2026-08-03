import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { buildReplyPromptCompilerInput, compileReplyPromptEnvelope } from '../src/plugins/reply/prompt/compiler.js';
import { migrateStructuredReplyHistoryRows } from '../src/plugins/reply/history-migration.js';
import {
  beginPromptAssemblyTurn,
  clearPromptAssemblyTurn,
  compilePromptEnvelope,
  registerPromptFragment,
} from '../src/plugins/shared/prompt-context/index.js';
import { resolveChatlunaSiblingPackageRoot, resolveChatlunaSourceRoot } from './helpers/chatluna-paths.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

describe('chatluna prompt pollution regression', () => {
  afterEach(() => {
    clearPromptAssemblyTurn('conv-prompt-pollution');
  });

  it('keeps reference fragments out of system messages', () => {
    beginPromptAssemblyTurn('conv-prompt-pollution');
    registerPromptFragment('conv-prompt-pollution', {
      source: 'qqbot_turn_context',
      title: 'User Turn Metadata',
      authority: 'reference',
      trust: 'trusted',
      ttl: 'turn',
      channel: 'required',
      payload: {
        kind: 'json',
        value: {
          user_name: '小祥',
          local_time: '2026-03-21 12:00:00',
        },
      },
    });

    const envelope = compilePromptEnvelope('conv-prompt-pollution');
    expect(envelope?.messages.map((message) => message.role)).toEqual(['human']);
    expect(
      envelope?.messages.some((message) =>
        String(message.content).includes('Respond naturally according to your system prompt'),
      ),
    ).toBe(false);
  });

  it('builds agent reply prompt messages without legacy finish-tool protocol text', () => {
    const envelope = compileReplyPromptEnvelope(
      buildReplyPromptCompilerInput(
        {
          input: {
            text: '只回复一句',
            imageParts: [{ type: 'image_url', image_url: { url: 'https://example.com/input.png' } }],
            hasImageInput: true,
            imageCount: 1,
            hasVoiceInput: false,
            displayName: '小祥',
            userId: 'u1',
            isDirect: true,
          },
          capabilitySnapshot: null,
          continuationContext: null,
        },
        [
          {
            source: 'qqbot_turn_context',
            title: 'User Turn Metadata',
            authority: 'reference',
            trust: 'trusted',
            ttl: 'turn',
      channel: 'required',
            payload: {
              kind: 'text',
              value: '现在是晚上',
            },
          },
        ],
      ),
    );

    expect(envelope?.messages.map((message) => message.role)).toEqual(['system', 'system', 'system', 'human']);
    expect(envelope?.messages.some((message) => String(message.content).includes('submit_reply_plan'))).toBe(false);
    expect(envelope?.messages.some((message) => String(message.content).includes('submit_working_state'))).toBe(false);
    expect(envelope?.messages.some((message) => String(message.content).includes('qqbot_reply_chat_style'))).toBe(false);
  });

  it('uses a chatluna build without pseudo natural-language after_user_message injection', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const executorSource = readFileSync(join(packageRoot, 'src/llm-core/agent/legacy-executor.ts'), 'utf8');

    expect(executorSource).toContain('after_user_message');
    expect(executorSource).toContain('mergeFinalResponseInstructionAfterUserMessage');
    expect(executorSource).not.toContain('AGENT_AFTER_USER_PROMPT');
    expect(executorSource).not.toContain('Respond naturally according to your system prompt');
  });

  it('keeps qqbot request extensions wired through agent chat chain construction', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const pluginChainSource = readFileSync(join(packageRoot, 'src/llm-core/chain/agent_chat_chain.ts'), 'utf8');

    expect(pluginChainSource).toContain('toolMask,');
    expect(pluginChainSource).toContain('copyQqbotRequestExtensions(requests, message)');
  });

  it('removes the legacy reply_plan module and switches executor to the final response contract', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const executorSource = readFileSync(join(packageRoot, 'src/llm-core/agent/legacy-executor.ts'), 'utf8');

    expect(existsSync(join(packageRoot, 'src/llm-core/agent/reply_plan.ts'))).toBe(false);
    expect(executorSource).not.toContain('finishContract.maxRetries');
    expect(executorSource).not.toContain('finishContract.retryMessage');
    expect(executorSource).toContain("type: 'json_schema'");
    expect(
      executorSource.includes('qqbot_final_response_contract')
      || executorSource.includes('qqbot_final_response_schema'),
    ).toBe(true);
  });

  it('removes plugin chat chain whole-turn retry loop', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const pluginChainSource = readFileSync(join(packageRoot, 'src/llm-core/chain/agent_chat_chain.ts'), 'utf8');

    expect(pluginChainSource).not.toContain('for (let i = 0; i < 3; i++)');
    expect(pluginChainSource).toContain('response = await request()');
  });

  it('wires the reply output contract through the plugin request path', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const pluginChainSource = readFileSync(join(packageRoot, 'src/llm-core/chain/agent_chat_chain.ts'), 'utf8');
    const executorSource = readFileSync(join(packageRoot, 'src/llm-core/agent/legacy-executor.ts'), 'utf8');

    expect(pluginChainSource).toContain("'qqbot_final_response_contract'");
    expect(pluginChainSource).toContain("'qqbot_final_response_schema'");
    expect(pluginChainSource).toContain("'qqbot_final_response_instruction'");
    expect(pluginChainSource).toContain("'overrideRequestParams'");
    expect(executorSource).toContain("type: 'json_schema'");
    expect(executorSource).toContain('buildFinalResponseOverrideRequestParams');
    expect(
      executorSource.includes('mergeFinalResponseInstructionAfterUserMessage')
      || executorSource.includes('qqbot_final_response_instruction'),
    ).toBe(true);
    expect(executorSource).not.toContain('buildFinalResponseMessage');
    expect(executorSource).not.toContain("tool_choice: 'none'");
    expect(executorSource).not.toContain('finalResponseMode');
    expect(executorSource).toContain('buildAgentPlanningConfig');
    expect(executorSource).toContain('const planningConfig = buildAgentPlanningConfig(input, config)');
    expect(executorSource).toContain('overrideRequestParams');
  });

  it('keeps provider-aware structured reply request overrides wired into the reply chain', () => {
    const generationSource = readFileSync(join(process.cwd(), 'src/plugins/reply/voice/generation.ts'), 'utf8');

    expect(generationSource).toContain('buildReplyOutputContract');
    expect(generationSource).toContain('mergeReplyOverrideRequestParams');
    expect(generationSource).toContain('overrideRequestParams');
  });

  it('keeps the linked OpenAI-like adapter wired for responses mode when requested by qqbot', () => {
    const sharedAdapterRoot = resolveChatlunaSiblingPackageRoot('shared-adapter');
    const openAiAdapterRoot = resolveChatlunaSiblingPackageRoot('adapter-openai-like');
    const sharedAdapterRequesterSource = readFileSync(join(sharedAdapterRoot, 'src', 'requester.ts'), 'utf8');
    const sharedAdapterControlSource = readFileSync(join(sharedAdapterRoot, 'src', 'internal_control.ts'), 'utf8');
    const openAIRequesterSource = readFileSync(join(openAiAdapterRoot, 'src', 'requester.ts'), 'utf8');

    expect(sharedAdapterRequesterSource).toContain('splitModelRequestOverrides');
    expect(sharedAdapterRequesterSource).toContain('.providerPayload');
    expect(sharedAdapterControlSource).toContain("key.startsWith('qqbot_')");
    expect(sharedAdapterControlSource).toContain('internalControl');
    expect(openAIRequesterSource).toContain('splitModelRequestOverrides');
    expect(openAIRequesterSource).toContain("internalControl.requestMode === 'responses'");
    expect(openAIRequesterSource).toContain("responseApiCompletion(");
  });

  it('keeps transient qqbot request controls out of persisted ChatLuna message metadata', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const historySource = readFileSync(join(packageRoot, 'src/llm-core/memory/message/database_history.ts'), 'utf8');

    expect(historySource).toContain('TRANSIENT_ADDITIONAL_KWARG_KEYS');
    expect(historySource).toContain("'qqbot_final_response_contract'");
    expect(historySource).toContain("'qqbot_input_content_meta'");
    expect(historySource).toContain("'qqbot_request_budget_policy'");
    expect(historySource).toContain('delete additionalArgs[key]');
  });

  it('uses a chatluna context manager build that accepts plain prompt message objects', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const contextManagerSource = readFileSync(join(packageRoot, 'src/llm-core/prompt/context_manager.ts'), 'utf8');

    expect(contextManagerSource).toContain('interface PlainPromptMessage');
    expect(contextManagerSource).toContain('isPlainPromptMessage');
    expect(contextManagerSource).toContain('createMessageFromPlainObject');
  });

  it('suppresses tool call thought rendering in qqbot agent reply mode', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const requestModelSource = readFileSync(join(packageRoot, 'src/middlewares/conversation/request_conversation.ts'), 'utf8');

    expect(requestModelSource).toContain('context.options.inputMessage?.additional_kwargs');
    expect(requestModelSource).toContain('qqbot_reply_mode ===');
    expect(requestModelSource).toContain("'agent'");
    expect(requestModelSource).toContain('return');
  });

  it('keeps reply request_conversation cleanup hooks wired through the request path', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const requestModelSource = readFileSync(join(packageRoot, 'src/middlewares/conversation/request_conversation.ts'), 'utf8');
    const chainSource = readFileSync(join(packageRoot, 'src/chains/chain.ts'), 'utf8');
    const generationSource = readFileSync(join(process.cwd(), 'src/plugins/reply/voice/generation.ts'), 'utf8');

    expect(requestModelSource).toContain('maybeHandleReplyRequestModelError');
    expect(requestModelSource).toContain('handleRequestModelError');
    expect(requestModelSource).toContain('e.setUserMessage(userMessage)');
    expect(chainSource).toContain('error.getUserMessage()');
    expect(generationSource).toContain('registerReplyRunRequestModelGuard');
    expect(generationSource).toContain('suppressReplyErrorNotice(session);');
    expect(generationSource).toContain('setReplyRequestModelErrorHandler(session, undefined);');
    expect(generationSource).toContain("executorBuilder.after('request_conversation');");
  });

  it('keeps multimodal content structured through request_conversation and shared-adapter boundaries', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const sharedAdapterRoot = resolveChatlunaSiblingPackageRoot('shared-adapter');
    const readChatMessageSource = readFileSync(join(packageRoot, 'src/middlewares/chat/read_chat_message.ts'), 'utf8');
    const requestModelSource = readFileSync(join(packageRoot, 'src/middlewares/conversation/request_conversation.ts'), 'utf8');
    const conversationRuntimeSource = readFileSync(join(packageRoot, 'src/services/conversation_runtime.ts'), 'utf8');
    const sharedAdapterSource = readFileSync(join(sharedAdapterRoot, 'src', 'utils.ts'), 'utf8');

    expect(readChatMessageSource).toContain("image_url: { url: imageUrl }");
    expect(readChatMessageSource).toContain('addTextPart(message, `[image:${imageText}]`)');
    expect(requestModelSource).toContain('qqbot_input_content_meta');
    expect(requestModelSource).toContain('ensureImageContentIntegrity');
    expect(requestModelSource).toContain('originContent.map(async (message) =>');
    expect(requestModelSource).not.toContain('sortContentByType(');
    expect(conversationRuntimeSource).toContain('serializeQqbotHumanMessageContent');
    expect(sharedAdapterSource).toContain('raw.detail');
    expect(sharedAdapterSource).not.toContain("detail: 'low'");
  });

  it('keeps tool-call history content as strings for OpenAI-compatible request payloads', () => {
    const sharedAdapterRoot = resolveChatlunaSiblingPackageRoot('shared-adapter');
    const sharedAdapterSource = readFileSync(join(sharedAdapterRoot, 'src', 'utils.ts'), 'utf8');
    const sharedAdapterBundle = readFileSync(join(sharedAdapterRoot, 'lib', 'index.mjs'), 'utf8');

    expect(sharedAdapterSource).toContain("rawMessage.content == null ? '' : rawMessage.content");
    expect(sharedAdapterSource).not.toContain("rawMessage.content === '' ? null : rawMessage.content");
    expect(sharedAdapterBundle).toContain('rawMessage.content == null ? "" : rawMessage.content');
    expect(sharedAdapterBundle).not.toContain('rawMessage.content === "" ? null : rawMessage.content');
  });

  it('keeps research history normalization bundle aligned with AIMessage imports', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const messageHistorySource = readFileSync(
      join(packageRoot, 'src', 'llm-core', 'memory', 'message', 'database_history.ts'),
      'utf8',
    );
    const messageHistoryBundle = readFileSync(
      join(packageRoot, 'lib', 'llm-core', 'memory', 'message', 'index.cjs'),
      'utf8',
    );

    expect(messageHistorySource).toContain('normalizeResearchReplyHistory');
    expect(messageHistorySource).toContain('new AIMessage(normalizedText)');
    expect(messageHistoryBundle).toContain('normalizeResearchReplyHistory');
    expect(messageHistoryBundle).toMatch(/new import_messages\d*\.AIMessage\(normalizedText\)/);
  });

  it('migrates legacy structured reply assistant history rows to visible text', async () => {
    const rows = [
      {
        id: 'legacy-json-ai',
        role: 'ai',
        content: await gzipAsync(JSON.stringify(JSON.stringify({
          decision: 'reply',
          outbound_messages: [
            { type: 'message', content: '你好' },
            { type: 'voice', content: '收到' },
            { type: 'image', assetRef: 'img-1', alt: '截图' },
            { type: 'meme', content: '无语' },
          ],
        }))),
      },
      {
        id: 'plain-ai',
        role: 'ai',
        content: await gzipAsync(JSON.stringify('普通历史')),
      },
    ];
    const updates: Array<{ table: string; query: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const database = {
      get: async () => rows,
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        updates.push({ table, query, update });
        const row = rows.find((item) => item.id === query.id);
        Object.assign(row ?? {}, update);
      },
      remove: async () => undefined,
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 2,
      migrated: 1,
      structuredRowsMigrated: 1,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(updates).toEqual([
      {
        table: 'chatluna_message',
        query: { id: 'legacy-json-ai' },
        update: { content: expect.any(Buffer) },
      },
    ]);
    await expect(gunzipAsync(rows[0].content).then((value) => value.toString())).resolves.toBe(JSON.stringify([
      '你好',
      '（发送语音：收到）',
      '（发送图片：截图）',
      '（发送表情包：无语）',
    ].join('\n')));
    await expect(gunzipAsync(rows[1].content).then((value) => value.toString())).resolves.toBe(JSON.stringify('普通历史'));
  });

  it('migrates native feature assistant media into semantic text history', async () => {
    const rows = [
      {
        id: 'native-feature-result-ai',
        role: 'ai',
        content: await gzipAsync(JSON.stringify([
          { type: 'text', text: '机器人返回了本学期成绩查询结果图片。' },
          { type: 'text', text: '[image:http://127.0.0.1:5140/storage/result.png]' },
          {
            type: 'image_url',
            image_url: { url: 'http://127.0.0.1:5140/storage/result.png' },
          },
        ])),
        additional_kwargs_binary: await gzipAsync(JSON.stringify({
          qqbot_native_feature: {
            version: 'v1',
            featureId: 'hbu-jw',
            commandId: 'term_scores',
            role: 'result',
            summary: '机器人返回了本学期成绩查询结果图片。',
          },
        })),
      },
    ];
    const database = {
      get: async () => rows,
      set: async (_table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const row = rows.find((item) => item.id === query.id);
        Object.assign(row ?? {}, update);
      },
      remove: async () => undefined,
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toMatchObject({
      scanned: 1,
      migrated: 1,
      structuredRowsMigrated: 1,
    });
    await expect(gunzipAsync(rows[0].content).then((value) => value.toString())).resolves.toBe(
      JSON.stringify('机器人返回了本学期成绩查询结果图片。'),
    );

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toMatchObject({
      scanned: 1,
      migrated: 0,
      structuredRowsMigrated: 0,
    });
  });

  it('migrates legacy rich-text reply history rows to visible text', async () => {
    const rows = [
      {
        id: 'legacy-rich-json-ai',
        role: 'ai',
        content: await gzipAsync(JSON.stringify(JSON.stringify({
          decision: 'reply',
          messages: [
            {
              modality: 'rich_text',
              segments: [
                { kind: 'mention', userId: '241389951' },
                { kind: 'text', text: ' 我查到了' },
              ],
            },
            { modality: 'meme', content: '无语' },
            {
              modality: 'voice',
              segments: [{ kind: 'text', text: '当然记得' }],
            },
            { kind: 'text', content: '补一句' },
          ],
        }))),
      },
      {
        id: 'plain-ai',
        role: 'ai',
        content: await gzipAsync(JSON.stringify('普通历史')),
      },
    ];
    const updates: Array<{ table: string; query: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const database = {
      get: async () => rows,
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        updates.push({ table, query, update });
        const row = rows.find((item) => item.id === query.id);
        Object.assign(row ?? {}, update);
      },
      remove: async () => undefined,
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 2,
      migrated: 1,
      structuredRowsMigrated: 1,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(updates).toEqual([
      {
        table: 'chatluna_message',
        query: { id: 'legacy-rich-json-ai' },
        update: { content: expect.any(Buffer) },
      },
    ]);
    await expect(gunzipAsync(rows[0].content).then((value) => value.toString())).resolves.toBe(JSON.stringify([
      '@241389951 我查到了',
      '（发送表情包：无语）',
      '（发送语音：当然记得）',
      '补一句',
    ].join('\n')));
    await expect(gunzipAsync(rows[1].content).then((value) => value.toString())).resolves.toBe(JSON.stringify('普通历史'));
  });

  it('clears non-AI tool_calls metadata without touching real assistant tool calls', async () => {
    const rows = [
      {
        id: 'human-dirty-tool-calls',
        role: 'human',
        content: await gzipAsync(JSON.stringify('旧 human 行')),
        tool_calls: '{}',
      },
      {
        id: 'human-string-null-tool-calls',
        role: 'human',
        content: await gzipAsync(JSON.stringify('旧 human null 行')),
        tool_calls: 'null',
      },
      {
        id: 'human-empty-array-tool-calls',
        role: 'human',
        content: await gzipAsync(JSON.stringify('旧 human empty array 行')),
        tool_calls: '[]',
      },
      {
        id: 'ai-real-tool-call',
        role: 'ai',
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: JSON.stringify([{ id: 'call-search', name: 'web_run', args: { search_query: [{ q: 'example' }] } }]),
      },
    ];
    const updates: Array<{ table: string; query: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const database = {
      get: async (table: string, _query: Record<string, unknown>) => table === 'chatluna_message' ? rows : [],
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        updates.push({ table, query, update });
        const row = rows.find((item) => item.id === query.id);
        Object.assign(row ?? {}, update);
      },
      remove: async () => undefined,
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 4,
      migrated: 3,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 3,
      emptyAssistantRowsRemoved: 0,
    });
    expect(updates).toEqual([
      {
        table: 'chatluna_message',
        query: { id: 'human-dirty-tool-calls' },
        update: { tool_calls: null },
      },
      {
        table: 'chatluna_message',
        query: { id: 'human-string-null-tool-calls' },
        update: { tool_calls: null },
      },
      {
        table: 'chatluna_message',
        query: { id: 'human-empty-array-tool-calls' },
        update: { tool_calls: null },
      },
    ]);
    expect(rows[0]).toEqual(expect.objectContaining({ tool_calls: null }));
    expect(rows[1]).toEqual(expect.objectContaining({ tool_calls: null }));
    expect(rows[2]).toEqual(expect.objectContaining({ tool_calls: null }));
    expect(rows[3]).toEqual(expect.objectContaining({
      tool_calls: JSON.stringify([{ id: 'call-search', name: 'web_run', args: { search_query: [{ q: 'example' }] } }]),
    }));
  });

  it('normalizes legacy CHAT_REPLY_V1 history rows to visible assistant text without mention headers', async () => {
    const rows = [
      {
        id: 'legacy-chat-reply-v1-ai',
        role: 'ai',
        content: await gzipAsync(JSON.stringify([
          'CHAT_REPLY_V1 abc12345',
          'DECISION reply',
          'BEGIN message',
          'MENTIONS none',
          '|今晚先这样吧',
          'END',
          'DONE abc12345',
        ].join('\n'))),
      },
      {
        id: 'current-chat-reply-v1-ai',
        role: 'ai',
        content: await gzipAsync(JSON.stringify([
          'CHAT_REPLY_V1 history',
          'DECISION reply',
          'BEGIN message',
          '|已经是当前格式',
          'END',
          'DONE history',
        ].join('\n'))),
      },
    ];
    const updates: Array<{ table: string; query: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const database = {
      get: async () => rows,
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        updates.push({ table, query, update });
        const row = rows.find((item) => item.id === query.id);
        Object.assign(row ?? {}, update);
      },
      remove: async () => undefined,
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 2,
      migrated: 2,
      structuredRowsMigrated: 2,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(updates).toEqual([
      {
        table: 'chatluna_message',
        query: { id: 'legacy-chat-reply-v1-ai' },
        update: { content: expect.any(Buffer) },
      },
      {
        table: 'chatluna_message',
        query: { id: 'current-chat-reply-v1-ai' },
        update: { content: expect.any(Buffer) },
      },
    ]);
    await expect(gunzipAsync(rows[0].content).then((value) => value.toString())).resolves.toBe(JSON.stringify('今晚先这样吧'));
    await expect(gunzipAsync(rows[1].content).then((value) => value.toString())).resolves.toBe(JSON.stringify('已经是当前格式'));
  });

  it('strips legacy assistant mention headers from visible assistant history', async () => {
    const rows = [
      {
        id: 'assistant-mention-header',
        role: 'ai',
        content: await gzipAsync(JSON.stringify('[assistant_message mentions=["1405359129"]] 已经记下了。')),
      },
      {
        id: 'assistant-action-mention-header',
        role: 'ai',
        content: await gzipAsync(JSON.stringify('（发送图片：出局.png）\n[assistant_message mentions=["1405359129"]] 出局。')),
      },
    ];
    const database = {
      get: async () => rows,
      set: async (_table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const row = rows.find((item) => item.id === query.id);
        Object.assign(row ?? {}, update);
      },
      remove: async () => undefined,
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 2,
      migrated: 2,
      structuredRowsMigrated: 2,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    await expect(
      gunzipAsync(rows[0].content).then((value) => value.toString()),
    ).resolves.toBe(JSON.stringify('已经记下了。'));
    await expect(
      gunzipAsync(rows[1].content).then((value) => value.toString()),
    ).resolves.toBe(JSON.stringify('（发送图片：出局.png）\n出局。'));
  });

  it('tags deterministic legacy direct human history rows with speaker identity', async () => {
    const messages = [
      {
        id: 'direct-invisible-name',
        conversationId: 'conv-direct-invisible',
        role: 'human',
        parentId: null,
        name: '⁢',
        content: await gzipAsync(JSON.stringify('晚安')),
      },
      {
        id: 'direct-named-import',
        conversationId: 'conv-direct-named',
        role: 'human',
        parentId: null,
        name: '失真',
        content: await gzipAsync(JSON.stringify('失真, 2026-03-09 20:17:37: 你没发现我就是不想让你练习吗')),
      },
      {
        id: 'direct-already-tagged',
        conversationId: 'conv-direct-named',
        role: 'human',
        parentId: 'direct-named-import',
        name: '失真',
        content: await gzipAsync(JSON.stringify('[speaker_id=180329167 speaker_name="失真"] 已经迁移')),
      },
      {
        id: 'group-legacy',
        conversationId: 'conv-group',
        role: 'human',
        parentId: null,
        name: '秋鹤.',
        content: await gzipAsync(JSON.stringify('祥子 是人吗')),
      },
    ];
    const conversations = [
      {
        id: 'conv-direct-invisible',
        bindingKey: 'personal:legacy:legacy:direct:1405359129',
        createdBy: '1405359129',
        title: '⁢ 的房间',
        legacyMeta: JSON.stringify({
          visibility: 'private',
          members: [{ userId: '1405359129' }],
        }),
      },
      {
        id: 'conv-direct-named',
        bindingKey: 'personal:legacy:legacy:direct:180329167',
        createdBy: '180329167',
        title: '180329167 的房间',
        legacyMeta: JSON.stringify({
          visibility: 'private',
          members: [{ userId: '180329167' }],
        }),
      },
      {
        id: 'conv-group',
        bindingKey: 'custom:legacy:room:110',
        createdBy: '1405359129',
        title: '群聊房间',
        legacyMeta: JSON.stringify({
          visibility: 'template_clone',
          groups: ['1091610889'],
          members: [{ userId: '1405359129' }, { userId: '241389951' }],
        }),
      },
    ];
    const updates: Array<{ table: string; query: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        updates.push({ table, query, update });
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async () => undefined,
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 4,
      migrated: 3,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 2,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 1,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(updates).toEqual([
      {
        table: 'chatluna_message',
        query: { id: 'direct-invisible-name' },
        update: { name: null },
      },
      {
        table: 'chatluna_message',
        query: { id: 'direct-invisible-name' },
        update: { content: expect.any(Buffer) },
      },
      {
        table: 'chatluna_message',
        query: { id: 'direct-named-import' },
        update: { content: expect.any(Buffer) },
      },
    ]);
    await expect(
      gunzipAsync(messages.find((row) => row.id === 'direct-invisible-name')!.content).then((value) => value.toString()),
    ).resolves.toBe(JSON.stringify('[speaker_id=1405359129 speaker_name="1405359129"] 晚安'));
    await expect(
      gunzipAsync(messages.find((row) => row.id === 'direct-named-import')!.content).then((value) => value.toString()),
    ).resolves.toBe(JSON.stringify('[speaker_id=180329167 speaker_name="失真"] 你没发现我就是不想让你练习吗'));
    await expect(
      gunzipAsync(messages.find((row) => row.id === 'direct-already-tagged')!.content).then((value) => value.toString()),
    ).resolves.toBe(JSON.stringify('[speaker_id=180329167 speaker_name="失真"] 已经迁移'));
    await expect(
      gunzipAsync(messages.find((row) => row.id === 'group-legacy')!.content).then((value) => value.toString()),
    ).resolves.toBe(JSON.stringify('祥子 是人吗'));
  });

  it('removes transient qqbot request metadata while preserving durable speaker metadata', async () => {
    const messages = [
      {
        id: 'human-transient',
        role: 'human',
        parentId: null,
        name: '⁢',
        content: await gzipAsync(JSON.stringify('[speaker_id=1405359129 speaker_name="高康嘉"] 你好')),
        additional_kwargs_binary: await gzipAsync(JSON.stringify({
          qqbot_input_content_meta: { hasImageInput: false, imageCount: 0 },
          qqbot_speaker_format: {
            version: 'speaker_id_v1',
            speakerId: '1405359129',
            speakerName: '高康嘉',
            isDirect: false,
            preformatted: true,
          },
          qqbot_attachment_refs: [{ refId: 'att_1', kind: 'image' }],
          qqbot_reply_mode: 'agent',
          qqbot_final_response_contract: { name: 'qqbot_structured_reply_v1' },
          qqbot_final_response_schema: { type: 'object' },
          qqbot_final_response_instruction: 'finish as json',
          qqbot_request_budget_policy: { imageDetail: 'low' },
          qqbot_override_request_params: { temperature: 0 },
          overrideRequestParams: { response_format: { type: 'json_schema' } },
          __chatluna_provider_response_diagnostic_v1: {
            requestMode: 'tool_calling',
            providerToolCallCount: 1,
            rawMessageKeys: ['content', 'tool_calls'],
          },
        })),
      },
      {
        id: 'ai-visible',
        role: 'ai',
        parentId: 'human-transient',
        name: null,
        content: await gzipAsync(JSON.stringify('你好。')),
        tool_calls: '[]',
        additional_kwargs_binary: null,
      },
    ];
    const conversations = [{ id: 'conv-transient', latestMessageId: 'ai-visible' }];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async () => undefined,
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 2,
      migrated: 2,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 1,
      invisibleMessageNamesCleared: 1,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(messages[0].name).toBeNull();
    const persisted = JSON.parse((await gunzipAsync(messages[0].additional_kwargs_binary as Buffer)).toString());
    expect(persisted).toEqual({
      qqbot_speaker_format: {
        version: 'speaker_id_v1',
        speakerId: '1405359129',
        speakerName: '高康嘉',
        isDirect: false,
        preformatted: true,
      },
    });
  });

  it('strips provider reasoning from visible assistant history without tool calls', async () => {
    const messages = [
      {
        id: 'human-reasoning',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('你好')),
        tool_calls: null,
        additional_kwargs_binary: null,
      },
      {
        id: 'ai-reasoning',
        role: 'ai',
        parentId: 'human-reasoning',
        name: null,
        content: await gzipAsync(JSON.stringify('你好。')),
        tool_calls: '[]',
        additional_kwargs_binary: await gzipAsync(JSON.stringify({
          reasoning_content: '这里是 provider 的内部推理，不应进入后续 ChatLuna 请求。',
        })),
      },
    ];
    const conversations = [{ id: 'conv-reasoning', latestMessageId: 'ai-reasoning' }];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async () => undefined,
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 2,
      migrated: 1,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 1,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(messages[1].additional_kwargs_binary).toBeNull();
  });

  it('strips empty provider tool_calls kwargs from visible assistant history', async () => {
    const messages = [
      {
        id: 'human-provider-tool-calls',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('继续')),
        tool_calls: null,
        additional_kwargs_binary: null,
      },
      {
        id: 'ai-provider-tool-calls',
        role: 'ai',
        parentId: 'human-provider-tool-calls',
        name: null,
        content: await gzipAsync(JSON.stringify('继续说。')),
        tool_calls: '[]',
        additional_kwargs_binary: await gzipAsync(JSON.stringify({
          tool_calls: null,
        })),
      },
      {
        id: 'ai-real-tool-call',
        role: 'ai',
        parentId: 'ai-provider-tool-calls',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: JSON.stringify([{ id: 'call-search', name: 'web_run', args: { search_query: [{ q: 'example' }] } }]),
        additional_kwargs_binary: await gzipAsync(JSON.stringify({
          tool_calls: [{ id: 'raw-call-search', function: { name: 'web_run', arguments: '{"search_query":[{"q":"example"}]}' } }],
        })),
      },
    ];
    const conversations = [{ id: 'conv-provider-tool-calls', latestMessageId: 'ai-real-tool-call' }];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async () => undefined,
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 3,
      migrated: 1,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 1,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(messages[1].additional_kwargs_binary).toBeNull();
    await expect(
      gunzipAsync(messages[2].additional_kwargs_binary as Buffer).then((value) => JSON.parse(value.toString())),
    ).resolves.toEqual({
      tool_calls: [{ id: 'raw-call-search', function: { name: 'web_run', arguments: '{"search_query":[{"q":"example"}]}' } }],
    });
  });

  it('collapses legacy submit_reply_plan tool-call history into visible assistant text', async () => {
    const messages = [
      {
        id: 'human-1',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('祥子 这是什么')),
      },
      {
        id: 'violation-prompt',
        role: 'human',
        parentId: 'human-1',
        name: null,
        content: await gzipAsync(JSON.stringify(
          'Protocol violation: reply-agent must finish by calling submit_reply_plan.\nYou may continue thinking.',
        )),
      },
      {
        id: 'ai-plan',
        role: 'ai',
        parentId: 'violation-prompt',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: JSON.stringify([
          {
            id: 'call-submit',
            name: 'submit_reply_plan',
            args: {
              segments: [
                { kind: 'sticker', content: '无语地看对方一眼' },
                { kind: 'text', content: '这是程序设计竞赛。' },
              ],
            },
          },
        ]),
      },
      {
        id: 'tool-plan',
        role: 'tool',
        parentId: 'ai-plan',
        name: 'submit_reply_plan',
        tool_call_id: 'call-submit',
        content: await gzipAsync(JSON.stringify('')),
      },
      {
        id: 'human-2',
        role: 'human',
        parentId: 'tool-plan',
        name: 'user',
        content: await gzipAsync(JSON.stringify('继续')),
      },
    ];
    const conversations = [
      {
        id: 'conv-legacy-plan',
        latestMessageId: 'tool-plan',
      },
    ];
    const removed: Array<{ table: string; query: Record<string, unknown> }> = [];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async (table: string, query: Record<string, unknown>) => {
        removed.push({ table, query });
        if (table !== 'chatluna_message') return;
        const index = messages.findIndex((row) => row.id === query.id);
        if (index >= 0) messages.splice(index, 1);
      },
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 5,
      migrated: 3,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 1,
      emptySubmitReplyPlanToolsRemoved: 1,
      protocolViolationPromptsRemoved: 1,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(messages.some((row) => row.id === 'tool-plan')).toBe(false);
    expect(messages.some((row) => row.id === 'violation-prompt')).toBe(false);
    expect(messages.find((row) => row.id === 'ai-plan')).toEqual(
      expect.objectContaining({
        parentId: 'human-1',
        tool_calls: [],
      }),
    );
    expect(messages.find((row) => row.id === 'human-2')).toEqual(expect.objectContaining({ parentId: 'ai-plan' }));
    expect(conversations[0].latestMessageId).toBe('ai-plan');
    expect(removed).toEqual([
      { table: 'chatluna_message', query: { id: 'tool-plan' } },
      { table: 'chatluna_message', query: { id: 'violation-prompt' } },
    ]);
    await expect(
      gunzipAsync(messages.find((row) => row.id === 'ai-plan')!.content).then((value) => value.toString()),
    ).resolves.toBe(JSON.stringify('（发送表情包：无语地看对方一眼）\n这是程序设计竞赛。'));
  });

  it('removes generic ChatLuna tool error tails from assistant history', async () => {
    const messages = [
      {
        id: 'human-1',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('帮我搜一下')),
      },
      {
        id: 'ai-search',
        role: 'ai',
        parentId: 'human-1',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: JSON.stringify([
          {
            id: 'call-search',
            name: 'web_run',
            args: {
              search_query: [{ q: 'example' }],
            },
          },
        ]),
      },
      {
        id: 'tool-error',
        role: 'tool',
        parentId: 'ai-search',
        name: 'web_run',
        tool_call_id: 'call-search',
        content: await gzipAsync(JSON.stringify(
          'Something went wrong. Please Try Again. 使用 ChatLuna 时出现错误，错误码为 103。请联系开发者以解决此问题。',
        )),
      },
      {
        id: 'ai-answer',
        role: 'ai',
        parentId: 'tool-error',
        name: null,
        content: await gzipAsync(JSON.stringify('我先按已有信息回答。')),
        tool_calls: '[]',
      },
    ];
    const conversations = [
      {
        id: 'conv-tool-error',
        latestMessageId: 'ai-answer',
      },
    ];
    const removed: Array<{ table: string; query: Record<string, unknown> }> = [];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async (table: string, query: Record<string, unknown>) => {
        removed.push({ table, query });
        if (table !== 'chatluna_message') return;
        const index = messages.findIndex((row) => row.id === query.id);
        if (index >= 0) messages.splice(index, 1);
      },
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 4,
      migrated: 2,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 2,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(messages.map((row) => row.id)).toEqual(['human-1', 'ai-answer']);
    expect(messages.find((row) => row.id === 'ai-answer')).toEqual(expect.objectContaining({ parentId: 'human-1' }));
    expect(conversations[0].latestMessageId).toBe('ai-answer');
    expect(removed).toEqual([
      { table: 'chatluna_message', query: { id: 'tool-error' } },
      { table: 'chatluna_message', query: { id: 'ai-search' } },
    ]);
  });

  it('removes dangling latest tool-call tails without visible assistant output', async () => {
    const messages = [
      {
        id: 'human-1',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('帮我查一下')),
      },
      {
        id: 'ai-tool-call',
        role: 'ai',
        parentId: 'human-1',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: JSON.stringify([
          {
            id: 'call-search',
            name: 'web_run',
            args: {
              search_query: [{ q: 'example' }],
            },
          },
        ]),
      },
      {
        id: 'tool-result',
        role: 'tool',
        parentId: 'ai-tool-call',
        name: 'web_run',
        tool_call_id: 'call-search',
        content: await gzipAsync(JSON.stringify('[turn0search0]\nTitle: 结果\nURL: https://example.com/\nSnippet: 示例')),
      },
    ];
    const conversations = [
      {
        id: 'conv-dangling-tool',
        latestMessageId: 'tool-result',
      },
    ];
    const removed: Array<{ table: string; query: Record<string, unknown> }> = [];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async (table: string, query: Record<string, unknown>) => {
        removed.push({ table, query });
        if (table !== 'chatluna_message') return;
        const index = messages.findIndex((row) => row.id === query.id);
        if (index >= 0) messages.splice(index, 1);
      },
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 3,
      migrated: 2,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 2,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(messages.map((row) => row.id)).toEqual(['human-1']);
    expect(conversations[0].latestMessageId).toBe('human-1');
    expect(removed).toEqual([
      { table: 'chatluna_message', query: { id: 'tool-result' } },
      { table: 'chatluna_message', query: { id: 'ai-tool-call' } },
    ]);
  });

  it('iteratively removes stacked dangling latest tool-call tails', async () => {
    const messages = [
      {
        id: 'human-1',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('继续查')),
      },
      {
        id: 'ai-tool-call-1',
        role: 'ai',
        parentId: 'human-1',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: JSON.stringify([{ id: 'call-glob', name: 'glob', args: { pattern: '**/*AGENTS*.md' } }]),
      },
      {
        id: 'tool-result-1',
        role: 'tool',
        parentId: 'ai-tool-call-1',
        name: 'glob',
        tool_call_id: 'call-glob',
        content: await gzipAsync(JSON.stringify('No files matched.')),
      },
      {
        id: 'ai-tool-call-2',
        role: 'ai',
        parentId: 'tool-result-1',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: JSON.stringify([{ id: 'call-read', name: 'file_read', args: { filePath: '/missing' } }]),
      },
      {
        id: 'tool-result-2',
        role: 'tool',
        parentId: 'ai-tool-call-2',
        name: 'file_read',
        tool_call_id: 'call-read',
        content: await gzipAsync(JSON.stringify('Error: missing file')),
      },
    ];
    const conversations = [
      {
        id: 'conv-stacked-tool',
        latestMessageId: 'tool-result-2',
      },
    ];
    const removed: Array<{ table: string; query: Record<string, unknown> }> = [];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async (table: string, query: Record<string, unknown>) => {
        removed.push({ table, query });
        if (table !== 'chatluna_message') return;
        const index = messages.findIndex((row) => row.id === query.id);
        if (index >= 0) messages.splice(index, 1);
      },
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 5,
      migrated: 4,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 4,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(messages.map((row) => row.id)).toEqual(['human-1']);
    expect(conversations[0].latestMessageId).toBe('human-1');
    expect(removed).toEqual([
      { table: 'chatluna_message', query: { id: 'tool-result-2' } },
      { table: 'chatluna_message', query: { id: 'ai-tool-call-2' } },
      { table: 'chatluna_message', query: { id: 'tool-result-1' } },
      { table: 'chatluna_message', query: { id: 'ai-tool-call-1' } },
    ]);
  });

  it('removes completed non-output tool traces while preserving the visible assistant reply', async () => {
    const messages = [
      {
        id: 'human-1',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('帮我搜一下')),
      },
      {
        id: 'ai-search',
        role: 'ai',
        parentId: 'human-1',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: JSON.stringify([{ id: 'call-search', name: 'web_run', args: { search_query: [{ q: 'example' }] } }]),
      },
      {
        id: 'tool-search',
        role: 'tool',
        parentId: 'ai-search',
        name: 'web_run',
        tool_call_id: 'call-search',
        content: await gzipAsync(JSON.stringify('[turn0search0]\nTitle: 结果\nURL: https://example.com/\nSnippet: 示例')),
      },
      {
        id: 'ai-answer',
        role: 'ai',
        parentId: 'tool-search',
        name: null,
        content: await gzipAsync(JSON.stringify('我查到结果了。')),
        tool_calls: '[]',
      },
    ];
    const conversations = [{ id: 'conv-completed-tool', latestMessageId: 'ai-answer' }];
    const removed: Array<{ table: string; query: Record<string, unknown> }> = [];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async (table: string, query: Record<string, unknown>) => {
        removed.push({ table, query });
        if (table !== 'chatluna_message') return;
        const index = messages.findIndex((row) => row.id === query.id);
        if (index >= 0) messages.splice(index, 1);
      },
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 4,
      migrated: 2,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 2,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(messages.map((row) => row.id)).toEqual(['human-1', 'ai-answer']);
    expect(messages.find((row) => row.id === 'ai-answer')).toEqual(expect.objectContaining({ parentId: 'human-1' }));
    expect(conversations[0].latestMessageId).toBe('ai-answer');
    expect(removed).toEqual([
      { table: 'chatluna_message', query: { id: 'tool-search' } },
      { table: 'chatluna_message', query: { id: 'ai-search' } },
    ]);
  });

  it('normalizes legacy send_sticker tool traces into visible assistant action history', async () => {
    const messages = [
      {
        id: 'human-1',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('发表情')),
      },
      {
        id: 'ai-sticker',
        role: 'ai',
        parentId: 'human-1',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: JSON.stringify([{ id: 'call-sticker', name: 'send_sticker', args: { tag: 'piano' } }]),
      },
      {
        id: 'tool-sticker',
        role: 'tool',
        parentId: 'ai-sticker',
        name: 'send_sticker',
        tool_call_id: 'call-sticker',
        content: await gzipAsync(JSON.stringify('已发送表情包: piano')),
      },
      {
        id: 'ai-answer',
        role: 'ai',
        parentId: 'tool-sticker',
        name: null,
        content: await gzipAsync(JSON.stringify('这样聊天会更轻松一点。')),
        tool_calls: '[]',
      },
    ];
    const conversations = [{ id: 'conv-sticker-tool', latestMessageId: 'ai-answer' }];
    const removed: Array<{ table: string; query: Record<string, unknown> }> = [];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async (table: string, query: Record<string, unknown>) => {
        removed.push({ table, query });
        if (table !== 'chatluna_message') return;
        const index = messages.findIndex((row) => row.id === query.id);
        if (index >= 0) messages.splice(index, 1);
      },
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 4,
      migrated: 2,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 2,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(messages.map((row) => row.id)).toEqual(['human-1', 'ai-sticker', 'ai-answer']);
    expect(messages.find((row) => row.id === 'ai-sticker')).toEqual(expect.objectContaining({
      parentId: 'human-1',
      tool_calls: [],
    }));
    expect(messages.find((row) => row.id === 'ai-answer')).toEqual(expect.objectContaining({ parentId: 'ai-sticker' }));
    expect(conversations[0].latestMessageId).toBe('ai-answer');
    expect(removed).toEqual([
      { table: 'chatluna_message', query: { id: 'tool-sticker' } },
    ]);
    await expect(
      gunzipAsync(messages.find((row) => row.id === 'ai-sticker')!.content).then((value) => value.toString()),
    ).resolves.toBe(JSON.stringify('（发送表情包：piano）'));
  });

  it('removes stale tool traces even when the next visible turn is human', async () => {
    const messages = [
      {
        id: 'human-1',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('抓一下网页')),
      },
      {
        id: 'ai-fetch',
        role: 'ai',
        parentId: 'human-1',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: JSON.stringify([{ id: 'call-fetch', name: 'web_run', args: { open: [{ ref_id: 'https://example.com' }] } }]),
      },
      {
        id: 'tool-fetch',
        role: 'tool',
        parentId: 'ai-fetch',
        name: 'web_run',
        tool_call_id: 'call-fetch',
        content: await gzipAsync(JSON.stringify('[turn0view0]\nTitle: Example Domain\nURL: https://example.com/\nContent:\n1: Example Domain')),
      },
      {
        id: 'human-2',
        role: 'human',
        parentId: 'tool-fetch',
        name: 'user',
        content: await gzipAsync(JSON.stringify('继续')),
      },
    ];
    const conversations = [{ id: 'conv-fetch-tool', latestMessageId: 'human-2' }];
    const removed: Array<{ table: string; query: Record<string, unknown> }> = [];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async (table: string, query: Record<string, unknown>) => {
        removed.push({ table, query });
        if (table !== 'chatluna_message') return;
        const index = messages.findIndex((row) => row.id === query.id);
        if (index >= 0) messages.splice(index, 1);
      },
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 4,
      migrated: 2,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 2,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 0,
    });

    expect(messages.map((row) => row.id)).toEqual(['human-1', 'human-2']);
    expect(messages.find((row) => row.id === 'human-2')).toEqual(expect.objectContaining({ parentId: 'human-1' }));
    expect(conversations[0].latestMessageId).toBe('human-2');
    expect(removed).toEqual([
      { table: 'chatluna_message', query: { id: 'tool-fetch' } },
      { table: 'chatluna_message', query: { id: 'ai-fetch' } },
    ]);
  });

  it('removes empty assistant history rows without tool calls', async () => {
    const messages = [
      {
        id: 'human-1',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('第一句')),
      },
      {
        id: 'empty-ai-a',
        role: 'ai',
        parentId: 'human-1',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: '[]',
      },
      {
        id: 'empty-ai-b',
        role: 'ai',
        parentId: 'empty-ai-a',
        name: null,
        content: null,
        tool_calls: '',
      },
      {
        id: 'human-2',
        role: 'human',
        parentId: 'empty-ai-b',
        name: 'user',
        content: await gzipAsync(JSON.stringify('第二句')),
      },
      {
        id: 'human-3',
        role: 'human',
        parentId: null,
        name: 'user',
        content: await gzipAsync(JSON.stringify('第三句')),
      },
      {
        id: 'empty-ai-latest',
        role: 'ai',
        parentId: 'human-3',
        name: null,
        content: await gzipAsync(JSON.stringify('')),
        tool_calls: null,
      },
    ];
    const conversations = [
      {
        id: 'conv-empty-chain',
        latestMessageId: 'human-2',
      },
      {
        id: 'conv-empty-latest',
        latestMessageId: 'empty-ai-latest',
      },
    ];
    const removed: Array<{ table: string; query: Record<string, unknown> }> = [];
    const database = {
      get: async (table: string, query: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        return rows.filter((row) =>
          Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        );
      },
      set: async (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => {
        const rows = table === 'chatluna_conversation' ? conversations : messages;
        for (const row of rows) {
          if (Object.entries(query).every(([key, value]) => (row as Record<string, unknown>)[key] === value)) {
            Object.assign(row, update);
          }
        }
      },
      remove: async (table: string, query: Record<string, unknown>) => {
        removed.push({ table, query });
        if (table !== 'chatluna_message') return;
        const index = messages.findIndex((row) => row.id === query.id);
        if (index >= 0) messages.splice(index, 1);
      },
    };

    await expect(migrateStructuredReplyHistoryRows(database)).resolves.toEqual({
      scanned: 6,
      migrated: 3,
      structuredRowsMigrated: 0,
      legacyDirectHumanRowsTagged: 0,
      submitReplyPlansMigrated: 0,
      emptySubmitReplyPlanToolsRemoved: 0,
      protocolViolationPromptsRemoved: 0,
      failedToolCallErrorRowsRemoved: 0,
      danglingToolCallTailRowsRemoved: 0,
      completedToolTraceRowsMigrated: 0,
      transientAdditionalKwargsRowsCleaned: 0,
      invisibleMessageNamesCleared: 0,
      nonAiToolCallsCleared: 0,
      emptyAssistantRowsRemoved: 3,
    });

    expect(messages.map((row) => row.id)).toEqual(['human-1', 'human-2', 'human-3']);
    expect(messages.find((row) => row.id === 'human-2')).toEqual(expect.objectContaining({ parentId: 'human-1' }));
    expect(conversations).toEqual([
      expect.objectContaining({ latestMessageId: 'human-2' }),
      expect.objectContaining({ latestMessageId: 'human-3' }),
    ]);
    expect(removed).toEqual([
      { table: 'chatluna_message', query: { id: 'empty-ai-a' } },
      { table: 'chatluna_message', query: { id: 'empty-ai-b' } },
      { table: 'chatluna_message', query: { id: 'empty-ai-latest' } },
    ]);
  });
});
