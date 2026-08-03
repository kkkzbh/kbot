import { buildStructuredReplyJsonSchema } from './structured-reply-schema.js';
import {
  buildVoiceOutputLanguageContractLines,
  normalizeVoiceOutputLanguage,
  type VoiceOutputLanguage,
} from '../voice/language.js';

export type ReplyOutputRequestMode = 'chat_completions' | 'responses';
export type ReplyOutputProtocol = 'native_chat_json_schema' | 'native_responses_json_schema' | 'chat_reply_v1';

export interface ReplyOutputContract {
  name: string;
  protocol: ReplyOutputProtocol;
  requestMode: ReplyOutputRequestMode;
  schema: Record<string, unknown> | null;
  instruction: string | null;
  overrideRequestParams: Record<string, unknown> | null;
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
  const payloadTypes = [
    '`message`',
    '`structured_block`',
    ...(options.canMeme === true ? ['`meme`'] : []),
    ...(options.canVoice === true ? ['`voice`'] : []),
  ];
  const lines = [
    '输出格式规则：',
    '- 最终回复必须严格使用 CHAT_REPLY_V1 文本协议，不要包裹 markdown fence，不要输出解释文字。',
    '- 第一条非空行必须是 `CHAT_REPLY_V1 <nonce>`；最后用 `DONE <nonce>`，首尾 nonce 必须一致。',
    '- `DECISION no_reply` 后只能输出 `DONE <nonce>`。',
    '- `DECISION reply` 必须输出一到四个 `BEGIN ... END` block。',
    `- ${payloadTypes.join('、')} 在 \`BEGIN <type>\` 后直接写以 \`|\` 开头的 payload 行。`,
    '- `image` 依次写 `ASSET_REF ...`、`ALT` 和 payload。',
    '- payload 内容行必须以 `|` 开头；空行也写成单独的 `|`，不要输出裸空行。裸 `END` 才结束 block。内容里需要写 END/DONE/BEGIN 时也必须写成 `|END`、`|DONE ...`、`|BEGIN ...`。',
    'no_reply 示例：',
    ['CHAT_REPLY_V1 abc12345', 'DECISION no_reply', 'DONE abc12345'].join('\n'),
    'message 示例：',
    ['CHAT_REPLY_V1 abc12345', 'DECISION reply', 'BEGIN message', '|收到，我看一下。', 'END', 'DONE abc12345'].join('\n'),
    'structured_block 示例：',
    ['BEGIN structured_block', '|1. 第一项', '|2. 第二项', 'END'].join('\n'),
    'image 示例：',
    ['BEGIN image', 'ASSET_REF <工具返回的 assetRef>', 'ALT', '|简短图像说明', 'END'].join('\n'),
  ];

  if (options.canMeme === true) {
    lines.push('meme block：', ['BEGIN meme', '|<具体自然的表情意图>', 'END'].join('\n'));
  }
  if (options.canVoice === true) {
    lines.push('voice block：', ['BEGIN voice', '|<要朗读的简短话语>', 'END'].join('\n'));
  }
  return lines;
}

export function buildChatReplyV1FinalInstruction(options: ReplyOutputLanguageOptions = {}): string {
  const payloadTypes = [
    'message',
    'structured_block',
    ...(options.canMeme === true ? ['meme'] : []),
    ...(options.canVoice === true ? ['voice'] : []),
  ];
  return [
    '最终只输出 CHAT_REPLY_V1 协议。直接输出普通聊天文本、Markdown 或解释文字均无效。',
    '`<nonce>` 使用任意 8 位以上字母数字串，首尾必须相同。',
    '回复格式：',
    'CHAT_REPLY_V1 <nonce>',
    'DECISION reply',
    `BEGIN <${payloadTypes.join('|')}>`,
    '|<内容；每一行都以 | 开头>',
    'END',
    'DONE <nonce>',
    '最多四个 BEGIN...END block。image block 依次写 BEGIN image、ASSET_REF <本轮工具返回值>、ALT、|<说明>、END。',
    '不回复时只写 CHAT_REPLY_V1 <nonce>、DECISION no_reply、DONE <nonce>。不要写 CONTENT。',
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
    overrideRequestParams: args.overrideRequestParams,
  };
}
