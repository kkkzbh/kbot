import { buildStructuredReplyJsonSchema } from './structured-reply-schema.js';
import {
  buildVoiceOutputLanguageContractLines,
  normalizeVoiceOutputLanguage,
  type VoiceOutputLanguage,
} from '../voice/language.js';
import { QQBOT_SUBMIT_REPLY_TOOL_NAME } from '../internal-tool-names.js';

export type ReplyOutputRequestMode = 'chat_completions' | 'responses';
export type ReplyOutputProtocol = 'native_chat_json_schema' | 'native_responses_json_schema' | 'chat_reply_v1';

export interface ReplyOutputContract {
  name: string;
  protocol: ReplyOutputProtocol;
  requestMode: ReplyOutputRequestMode;
  schema: Record<string, unknown> | null;
  instruction: string | null;
  overrideRequestParams: Record<string, unknown> | null;
  terminalTool: string | null;
}

export function buildReplyOutputContractAdditionalKwargs(
  contract: ReplyOutputContract,
  options: {
    overrideRequestParams?: Record<string, unknown> | null;
  } = {},
): Record<string, unknown> {
  return {
    qqbot_final_response_contract: contract,
    ...(contract.schema ? { qqbot_final_response_schema: contract.schema } : {}),
    ...(contract.instruction ? { qqbot_final_response_instruction: contract.instruction } : {}),
    ...(options.overrideRequestParams ? { overrideRequestParams: options.overrideRequestParams } : {}),
  };
}

export interface ReplyOutputLanguageOptions {
  voiceOutputLanguage?: VoiceOutputLanguage;
  canVoice?: boolean;
  canMeme?: boolean;
  stickerIntentHints?: readonly string[];
}

export function buildReplySemanticContractLines(options: ReplyOutputLanguageOptions = {}): string[] {
  const voiceOutputLanguage = normalizeVoiceOutputLanguage(options.voiceOutputLanguage);
  const lines = [
    '结构化回复语义规则：',
    '- 文本是默认表达方式。日常聊天通常用一到三条短消息，每条只讲一件事；确实需要解释或保留结构时再展开。',
    '- 不要为了显得热情而重复结论、追加总结，或习惯性地用问题收尾。',
    '- 普通聊天文本用 `message`。',
    '- 需要 @ 群成员时，直接在 `message.content` 里写 `@群名片 `、`@昵称 ` 或 `@QQ号 `，注意 @ 目标后必须有空格。',
    '- 只有需要呼叫当前未参与该群聊天的人时才 @；即使是在回应当前说话人，也不要默认 @。',
    '- 代码、列表、引用等需要保留结构的内容用 `structured_block`。',
    '- 工具没拿到预期信息时，说清楚哪件事没查到并继续使用可行的方法；面向用户用日常语言，避免“来源失败”“响应异常”“获取失败”等系统词。',
    '- 只有工具为本轮答案返回了图片 `assetRef` 时才使用 `image`，并填写该 `assetRef` 与简短 `alt`。',
    '- 如果工具结果里带有 `image.assetRef`，且该图片就是当前答案的一部分，最终回复必须包含对应 `image` 消息，不能只复述文字摘要。',
    '- 不要输出 `[CQ:at]`、`<at ...>` 或任何平台控制标签。',
    '- `result.decision=no_reply` 表示本轮不发送消息；`result.decision=reply` 必须至少给出一项实际内容。',
  ];

  if (options.canMeme === true) {
    const stickerHintLine = options.stickerIntentHints?.length
      ? `- 可匹配的表情意图包括：${options.stickerIntentHints.join('、')}。从中选择最贴近当前语境的一种。`
      : null;
    lines.splice(-2, 0,
      '- 当前回合允许使用一个 `meme` 作为非必要的情绪反应；只在接梗、调侃或轻松回应中使用，`content` 写具体自然的表情意图。',
      '- `meme` 不承载事实或行动信息。严肃话题、道歉、故障说明和重要建议只用文字。',
      ...(stickerHintLine ? [stickerHintLine] : []),
    );
  }

  if (options.canVoice === true) {
    lines.splice(-2, 0,
      '- 当前回合允许使用一条简短 `voice`。语音适合承接对方的语音、明确的语音请求，或私聊中的短暂安慰与祝福。',
      '- 链接、代码、列表、事实说明和需要回看的内容保留为文字。',
      ...buildVoiceOutputLanguageContractLines(voiceOutputLanguage),
    );
  }

  return lines;
}

export function buildNativeJsonOutputContractLines(_options: ReplyOutputLanguageOptions = {}): string[] {
  return [
    '输出格式规则：',
    '- 最终只返回符合请求所附 StructuredReplyEnvelope JSON Schema 的 object。',
    '- `result.messages` 保留文字、结构块和图片的发送顺序；语音与表情包使用各自的单项字段。',
    '- 不要包裹 markdown fence，也不要在 object 前后输出解释文字。',
  ];
}

export function buildChatReplyV1OutputContractLines(options: ReplyOutputLanguageOptions = {}): string[] {
  return [
    '最终回复提交规则：',
    `- 完成需要的查找、回忆或操作后，调用 \`${QQBOT_SUBMIT_REPLY_TOOL_NAME}\` 提交最终回复。`,
    '- 最终回复只能通过这个工具提交；不要在工具调用外直接输出聊天正文。',
    '- `result.decision=reply` 时，用 `result.messages` 按发送顺序提交文字、结构块和工具产生的图片。',
    '- 普通聊天用 `message`；需要保留列表、代码或引用结构时用 `structured_block`。',
    '- `result.decision=no_reply` 时，`messages`、`voice_message`、`meme_message` 都填写 null。',
    ...(options.canMeme === true
      ? ['- 当前允许 `meme_message`，每轮最多一个；填写具体自然的表情意图。']
      : ['- 当前不允许表情包，`meme_message` 必须填写 null。']),
    ...(options.canVoice === true
      ? ['- 当前允许 `voice_message`，每轮最多一个；填写要朗读的简短话语。']
      : ['- 当前不允许语音，`voice_message` 必须填写 null。']),
  ];
}

export function buildChatReplyV1FinalInstruction(options: ReplyOutputLanguageOptions = {}): string {
  return [
    `完成本轮工作后，必须调用 \`${QQBOT_SUBMIT_REPLY_TOOL_NAME}\` 提交最终回复。`,
    '不要直接输出普通文本、Markdown、JSON 或内部协议。',
    ...(options.canMeme === true
      ? ['当前允许 meme_message。']
      : ['当前不允许 meme_message，必须填 null。']),
    ...(options.canVoice === true
      ? ['当前允许 voice_message。']
      : ['当前不允许 voice_message，必须填 null。']),
    ...(options.canVoice === true
      ? buildVoiceOutputLanguageContractLines(normalizeVoiceOutputLanguage(options.voiceOutputLanguage))
      : []),
  ].join('\n');
}

export function buildReplyOutputInstruction(
  protocol: ReplyOutputProtocol,
  options: ReplyOutputLanguageOptions = {},
): string | null {
  if (protocol !== 'chat_reply_v1') return null;

  return buildChatReplyV1FinalInstruction(options);
}

export function createReplyOutputContract(args: {
  requestMode: ReplyOutputRequestMode;
  protocol: ReplyOutputProtocol;
  overrideRequestParams: Record<string, unknown> | null;
  name?: string;
  canVoice?: boolean;
  canMeme?: boolean;
  stickerIntentHints?: readonly string[];
  voiceOutputLanguage?: VoiceOutputLanguage;
}): ReplyOutputContract {
  const schema = args.protocol === 'chat_reply_v1'
    ? null
    : buildStructuredReplyJsonSchema({
      canVoice: args.canVoice,
      canMeme: args.canMeme,
      stickerIntentHints: args.stickerIntentHints,
      voiceOutputLanguage: args.voiceOutputLanguage,
    });

  return {
    name: args.name ?? 'qqbot_structured_reply_v1',
    protocol: args.protocol,
    requestMode: args.requestMode,
    schema,
    instruction: buildReplyOutputInstruction(args.protocol, {
      voiceOutputLanguage: args.voiceOutputLanguage,
      canVoice: args.canVoice,
      canMeme: args.canMeme,
      stickerIntentHints: args.stickerIntentHints,
    }),
    overrideRequestParams: args.protocol === 'chat_reply_v1'
      ? {
          ...(args.overrideRequestParams ?? {}),
          tool_choice: 'required',
          parallel_tool_calls: false,
        }
      : args.overrideRequestParams,
    terminalTool: args.protocol === 'chat_reply_v1'
      ? QQBOT_SUBMIT_REPLY_TOOL_NAME
      : null,
  };
}
