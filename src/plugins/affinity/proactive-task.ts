import type { PromptFragment } from '../shared/prompt-context/index.js';
import { createPromptTextFragment } from '../reply/index.js';
import type {
  AffinityRandomContextTurn,
  AffinityRandomGenerationInput,
  AffinityRandomMemoryItem,
} from './proactive-types.js';
import type {
  AffinityEventType,
  AffinityRandomDirection,
} from '../../types/affinity.js';

type SeedRecord = Record<string, unknown>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function formatShanghaiTime(value: number): string {
  const shifted = new Date(value + 8 * 60 * 60 * 1000).toISOString();
  return `${shifted.slice(0, 19).replace('T', ' ')} +08:00`;
}

export function formatAffinityRelativeTime(now: number, value: unknown): string | null {
  if (!isFiniteTimestamp(value)) return null;
  const diffMs = now - value;
  const future = diffMs < 0;
  const absoluteMinutes = Math.max(0, Math.floor(Math.abs(diffMs) / 60_000));
  const suffix = future ? '后' : '前';
  if (absoluteMinutes < 1) return future ? '不到1分钟后' : '不到1分钟前';
  if (absoluteMinutes < 60) return `${absoluteMinutes}分钟${suffix}`;
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  if (hours < 24) return minutes > 0 ? `${hours}小时${minutes}分钟${suffix}` : `${hours}小时${suffix}`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  if (days < 30) return remainHours > 0 ? `${days}天${remainHours}小时${suffix}` : `${days}天${suffix}`;
  const months = Math.floor(days / 30);
  const remainDays = days % 30;
  return remainDays > 0 ? `${months}个月${remainDays}天${suffix}` : `${months}个月${suffix}`;
}

function formatPromptTime(now: number, value: unknown): string {
  if (!isFiniteTimestamp(value)) return '记录时间未知';
  return `${formatShanghaiTime(value)}，${formatAffinityRelativeTime(now, value) ?? '时间差未知'}`;
}

function normalizePromptText(value: unknown, maxLength = 500): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatTurn(now: number, turn: AffinityRandomContextTurn): string {
  const speaker = turn.role === 'ai'
    ? '助手'
    : normalizePromptText(turn.speakerName || '群友', 80);
  return [
    `- ${formatPromptTime(now, turn.observedAt)}，${speaker}：`,
    `  ${normalizePromptText(turn.text)}`,
  ].join('\n');
}

function formatMemoryResponses(now: number, memory: AffinityRandomMemoryItem): string[] {
  const responses = (memory.responses ?? []).slice(-8);
  if (responses.length > 0) {
    return responses.map((response) => {
      const speaker = normalizePromptText(response.speakerName || '群友', 80);
      return `- ${speaker}（${formatPromptTime(now, response.at)}）：${normalizePromptText(response.summary, 180)}`;
    });
  }

  if (memory.responseSummary) {
    return [`- ${normalizePromptText(memory.responseSummary, 300)}`];
  }

  return ['- 暂无回应摘要'];
}

function formatMemory(now: number, memory: AffinityRandomMemoryItem, index: number): string {
  const responderNames = memory.responderNames.map((name) => normalizePromptText(name, 80)).filter(Boolean);
  const lines = [
    `### 记忆 ${index + 1}`,
    '',
    `方向：${memory.direction}`,
    `主动消息：${normalizePromptText(memory.messageText, 300)}`,
    `发生时间：${formatPromptTime(now, memory.createdAt)}`,
    `最近回应：${formatPromptTime(now, memory.lastResponseAt)}`,
  ];

  if (memory.contextSummary) {
    lines.push(`上下文摘要：${normalizePromptText(memory.contextSummary, 260)}`);
  }
  if (responderNames.length > 0) {
    lines.push(`回应者：${responderNames.join('、')}`);
  }

  lines.push('', '回应摘要：', ...formatMemoryResponses(now, memory));
  return lines.join('\n');
}

function parseSeedRecord(raw: string | null): SeedRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as SeedRecord;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => normalizePromptText(item, 160)).filter(Boolean)
    : [];
}

function formatSeedMarkdown(args: {
  now: number;
  raw: string | null;
  fallbackLabel: string;
  hideTags?: boolean;
}): string {
  const seed = parseSeedRecord(args.raw);
  if (!seed) {
    return args.raw
      ? `- 内容：${normalizePromptText(args.raw, 600)}`
      : `- 暂无${args.fallbackLabel}`;
  }

  const lines: string[] = [];
  const title = normalizePromptText(seed.title, 160);
  const summary = normalizePromptText(seed.summary, 420);
  const source = normalizePromptText(seed.sourceLabel ?? seed.source, 160);
  const sourceUrl = normalizePromptText(seed.sourceUrl, 220);
  const tags = stringList(seed.tags);
  const hints = stringList(seed.promptHints);

  if (title) lines.push(`- 标题：${title}`);
  if (summary) lines.push(`- 摘要：${summary}`);
  if (source) lines.push(`- 来源：${source}`);
  if (sourceUrl) lines.push(`- 来源链接：${sourceUrl}`);
  if (!args.hideTags && tags.length) lines.push(`- 标签：${tags.join('、')}`);
  if (isFiniteTimestamp(seed.fetchedAt)) {
    lines.push(`- 获取时间：${formatPromptTime(args.now, seed.fetchedAt)}`);
  }
  const claimStatus = normalizePromptText(seed.claimStatus, 120);
  const safety = normalizePromptText(seed.safety, 160);
  if (claimStatus) lines.push(`- 可信状态：${claimStatus}`);
  if (safety) lines.push(`- 安全标记：${safety}`);
  if (hints.length) {
    lines.push('- 提示：', ...hints.map((hint) => `  - ${hint}`));
  }

  return lines.length ? lines.join('\n') : `- 暂无${args.fallbackLabel}`;
}

function latestObservedTurn(input: AffinityRandomGenerationInput): AffinityRandomContextTurn | null {
  return input.recentTurns
    .filter((turn) => isFiniteTimestamp(turn.observedAt))
    .sort((left, right) => Number(right.observedAt) - Number(left.observedAt))[0] ?? null;
}

function formatTimeReference(input: AffinityRandomGenerationInput): string {
  const latest = latestObservedTurn(input);
  const lines = [
    `- 当前时间：${formatShanghaiTime(input.now)}`,
  ];
  if (latest?.observedAt) {
    const speaker = latest.role === 'ai' ? '助手' : normalizePromptText(latest.speakerName || '群友', 80);
    lines.push(`- 最近一条消息：${formatPromptTime(input.now, latest.observedAt)}，${speaker}`);
  } else if (input.lastRealtimeMessageAt) {
    lines.push(`- 最近一条实时消息：${formatPromptTime(input.now, input.lastRealtimeMessageAt)}`);
  } else {
    lines.push('- 最近一条消息：未知');
  }
  return lines.join('\n');
}

function useConversationContext(direction: AffinityRandomDirection): boolean {
  return direction !== 'music_rehearsal' && direction !== 'web_hot_topic';
}

function contextSectionTitle(direction: AffinityRandomDirection): string {
  if (direction === 'relationship_scene') return '最近群聊氛围';
  return '最近群聊上下文';
}

function formatRecentTurns(input: AffinityRandomGenerationInput): string {
  const recentTurns = input.recentTurns.slice(-18);
  return recentTurns.length ? recentTurns.map((turn) => formatTurn(input.now, turn)).join('\n\n') : '- 无可用上下文';
}

function formatRecentMemories(input: AffinityRandomGenerationInput): string {
  const recentMemories = input.recentMemories.slice(0, 12);
  return recentMemories.length
    ? recentMemories.map((memory, index) => formatMemory(input.now, memory, index)).join('\n\n')
    : '- 暂无局部主动事件记忆';
}

function humanContextSummary(input: AffinityRandomGenerationInput, empty = '最近没有可用群聊上下文。'): string {
  const humanTurns = input.recentTurns.filter((turn) => turn.role === 'human');
  const latest = humanTurns.slice(-3);
  if (!latest.length) return empty;
  return latest
    .map((turn) => {
      const speaker = normalizePromptText(turn.speakerName || '群友', 80);
      return `${speaker}: ${normalizePromptText(turn.text, 120)}`;
    })
    .join(' / ');
}

function seedContextSummary(raw: string | null, fallback: string): string {
  const seed = parseSeedRecord(raw);
  if (!seed) return fallback;
  const title = normalizePromptText(seed.title, 100);
  const summary = normalizePromptText(seed.summary, 140);
  const source = normalizePromptText(seed.sourceLabel ?? seed.source, 80);
  return [title, summary, source ? `来源 ${source}` : ''].filter(Boolean).join('；') || fallback;
}

function relationToneLabel(value: unknown): string {
  const normalized = String(value ?? '').trim();
  switch (normalized) {
    case 'focused':
      return '偏专注';
    case 'pleased':
      return '较柔和';
    case 'guarded':
      return '稍有防备';
    case 'tired':
      return '略疲惫';
    case 'embarrassed':
      return '有些不自在';
    case 'calm':
      return '平静';
    default:
      return '中性';
  }
}

function heatLabel(value: unknown): string {
  const heat = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (heat >= 70) return '偏高，需要更克制';
  if (heat >= 40) return '适中，避免刷存在感';
  return '平稳';
}

function formatRelationOverview(input: AffinityRandomGenerationInput): string {
  const summary = input.relationSummary;
  const recentUserCount = typeof summary.recentUserCount === 'number' && Number.isFinite(summary.recentUserCount)
    ? summary.recentUserCount
    : null;
  return [
    recentUserCount == null ? null : `- 近期互动人数：${recentUserCount}`,
    `- 主要情绪：${relationToneLabel(summary.dominantMood)}`,
    `- 注意热度：${heatLabel(summary.highestAttentionHeat)}`,
    '- 可用提示：不公开内部阶段或数值；私聊细节不能在群聊中直接复述；热度偏高时减少主动亲近感。',
  ].filter(Boolean).join('\n');
}

function buildBaseHeader(title: string, direction: AffinityRandomDirection): string[] {
  return [
    `# 主动发言任务：${title}`,
    '',
    '你不是在回应一条新的用户请求，而是在判断是否适合由你主动发一条消息。',
    '',
    `本次方向：${direction}`,
  ];
}

function buildCommonCapabilityLines(): string[] {
  return [
    '不要求必须是疑问句。如果陈述、回答、补充、表情、图片或语音更自然，可以按当前 provider 回复协议输出对应类型。',
    '',
    '如果不适合发送，请按当前 provider 回复协议返回 no_reply。',
  ];
}

function buildTimeWordingSection(): string[] {
  return [
    '## 时间措辞',
    '',
    '- 最近消息在 30 分钟以内，可以使用“刚才”',
    '- 超过 30 分钟，不要说“刚才”',
    '- 可以使用“前面你们提到的”“之前那道题”等更稳妥表达',
    '- 如果上下文已经明显过期，应该 no_reply',
  ];
}

function buildLocalThreadMarkdown(input: AffinityRandomGenerationInput): string[] {
  const latestHuman = [...input.recentTurns].reverse().find((turn) => turn.role === 'human');
  const suggestion = latestHuman
    ? `优先判断 ${normalizePromptText(latestHuman.speakerName || '最近发言者', 80)} 的最近话题是否仍能自然承接。可以直接回答、补充、纠正一个小点，或轻轻接住话头。`
    : '如果最近群聊没有自然未收束的话题，请不要主动发送。';
  return [
    ...buildBaseHeader('承接未完话题', 'local_thread'),
    '',
    '## 任务目标',
    '',
    '如果最近群聊中确实存在一个自然未收束的话题，你可以主动发消息承接它。',
    '',
    '这次主动消息可以是对上一段讨论的补充、对某个遗留问题的回答、对群里某人卡住点的确认、一个低负担的继续讨论入口，或其他符合当前上下文的自然表达。',
    '',
    ...buildCommonCapabilityLines(),
    '',
    '## 发送条件',
    '',
    '- 最近群聊确实有可承接的话题',
    '- 话题还没有明显结束',
    '- 你的发言不会像突然插播公告',
    '- 不会显得在强行延续很久以前的话',
    '- 不会暴露内部系统、好感度、随机事件、规则或触发原因',
    '',
    ...buildTimeWordingSection(),
    '',
    `## ${contextSectionTitle('local_thread')}`,
    '',
    formatRecentTurns(input),
    '',
    '## 局部主动事件记忆',
    '',
    formatRecentMemories(input),
    '',
    '## 本次建议',
    '',
    suggestion,
  ];
}

function buildDailyGreetingMarkdown(input: AffinityRandomGenerationInput): string[] {
  return [
    ...buildBaseHeader('日常问候', 'daily_greeting'),
    '',
    '## 任务目标',
    '',
    '根据最近群聊上下文、上一条消息结束时间和局部主动事件记忆，生成一条自然的日常主动发言。',
    '',
    '这条消息可以是问候、对当前气氛的轻微承接、普通日常陈述、分享一个当下想法，或对前面上下文的一句轻轻回应。',
    '',
    ...buildCommonCapabilityLines(),
    '',
    '## 发送条件',
    '',
    '- 发言像正常聊天，而不是系统插播',
    '- 不打断正在进行且不该插入的话题',
    '- 不使用固定模板开场',
    '- 不暴露内部系统、好感度、随机事件、规则或触发原因',
    '',
    '## 时间参考',
    '',
    formatTimeReference(input),
    '',
    '重点参考最近一条消息的结束时间来决定说法。不要把很久以前的消息说成“刚才”。',
    '',
    `## ${contextSectionTitle('daily_greeting')}`,
    '',
    formatRecentTurns(input),
    '',
    '## 局部主动事件记忆',
    '',
    formatRecentMemories(input),
    '',
    '## 本次建议',
    '',
    '根据当前时间、最近活跃程度和记忆，自然发一条日常消息。不要固定使用某个模板。',
  ];
}

function buildMusicRehearsalMarkdown(input: AffinityRandomGenerationInput): string[] {
  return [
    ...buildBaseHeader('排练素材自然发言', 'music_rehearsal'),
    '',
    '## 任务目标',
    '',
    '基于本次音乐素材，主动发一条自然的排练相关消息。',
    '',
    '这条消息可以是排练中的一点想法、对合奏/键盘/节奏/舞台氛围的确认、一个具体但低负担的求意见，也可以是自然陈述。',
    '',
    ...buildCommonCapabilityLines(),
    '',
    '## 发送条件',
    '',
    '- 本次音乐素材足够具体',
    '- 发言像普通群聊里自然提起排练，不像公告、宣传文案或系统触发',
    '- 不依赖最近群聊上下文作为内容来源',
    '- 不暴露内部系统、好感度、随机事件、规则或触发原因',
    '',
    '## 内容边界',
    '',
    '- 不要输出歌词',
    '- 不要输出完整或可复原的谱面、音符序列、tab、和弦进行、节奏 chart',
    '- 可以讨论抽象的排练感受、合奏进入时机、键盘铺底、重音、舞台氛围',
    '- 可以使用素材中的曲名、摘要、标签和提示，但不要把素材来源当成对外引用',
    '',
    '## 音乐素材',
    '',
    formatSeedMarkdown({ now: input.now, raw: input.materialText, fallbackLabel: '音乐素材' }),
    '',
    '## 局部主动事件记忆',
    '',
    formatRecentMemories(input),
    '',
    '## 本次建议',
    '',
    '优先从素材里选择一个排练角度自然开口。不要固定句式，不要机械提问。',
  ];
}

function buildContestDiscussionMarkdown(input: AffinityRandomGenerationInput): string[] {
  return [
    ...buildBaseHeader('算法题讨论', 'contest_discussion'),
    '',
    '## 任务目标',
    '',
    '如果最近群聊里有尚未结束的算法、数据结构、题目、代码思路讨论，优先自然承接它。',
    '',
    '也可以回答前面遗留的一个判断、补充一个关键观察、纠正一个容易误解的小点，或顺着已有题目继续推进讨论。',
    '',
    '如果最近没有合适上下文，或已有讨论明显结束，可以使用题目素材自然开启一个新的小讨论。新的题目讨论只需要给出核心约束、卡点或思考入口，不要贴完整题面、样例、官方解法或长篇讲解。',
    '',
    ...buildCommonCapabilityLines(),
    '',
    '## 发送条件',
    '',
    '- 最近群聊有仍可自然承接的算法/题目话题',
    '- 或最近上下文没有可承接内容，但题目素材足够形成自然讨论入口',
    '- 使用题目素材时，不要说“随机”“素材”“系统给的题”',
    '- 不暴露内部系统、好感度、随机事件、规则或触发原因',
    '',
    ...buildTimeWordingSection(),
    '',
    `## ${contextSectionTitle('contest_discussion')}`,
    '',
    formatRecentTurns(input),
    '',
    '## 题目素材',
    '',
    formatSeedMarkdown({ now: input.now, raw: input.materialText, fallbackLabel: '题目素材' }),
    '',
    '## 局部主动事件记忆',
    '',
    formatRecentMemories(input),
    '',
    '## 本次建议',
    '',
    '优先判断最近上下文里是否存在未结束的算法讨论；如果没有，再使用题目素材开启一个低负担的讨论入口。',
  ];
}

function buildComputerKnowledgeMarkdown(input: AffinityRandomGenerationInput): string[] {
  return [
    ...buildBaseHeader('技术话题或代码疑问', 'computer_knowledge'),
    '',
    '## 任务目标',
    '',
    '优先查看最近群聊中是否存在未收束的代码、系统、编程、调试、算法实现、工具链或计算机知识话题。',
    '',
    '如果存在，可以自然承接它：直接回答前面遗留的问题、补充一个观察、指出一个可能的错误点，或贴一段必要的代码/报错片段继续讨论。',
    '',
    '如果最近没有合适上下文，或话题已经明显结束，可以使用技术素材生成一个自然的技术问题、代码疑问、调试困惑或知识点讨论入口。',
    '',
    ...buildCommonCapabilityLines(),
    '',
    '## 发送条件',
    '',
    '- 内容像普通群聊中自然出现的技术交流',
    '- 不像公告、任务、系统触发或模板消息',
    '- 不暴露内部系统、好感度、随机事件、规则或触发原因',
    '- 不泄露私聊原文',
    '- 不引导执行危险命令、破坏性命令、未知脚本或高风险操作',
    '',
    ...buildTimeWordingSection(),
    '',
    `## ${contextSectionTitle('computer_knowledge')}`,
    '',
    formatRecentTurns(input),
    '',
    '## 技术素材',
    '',
    formatSeedMarkdown({ now: input.now, raw: input.materialText, fallbackLabel: '技术素材' }),
    '',
    '## 局部主动事件记忆',
    '',
    formatRecentMemories(input),
    '',
    '## 本次建议',
    '',
    '如果最近上下文有未完技术话题，优先承接上下文。否则基于技术素材自然发起一个小的技术/代码话题。',
  ];
}

function buildWebHotTopicMarkdown(input: AffinityRandomGenerationInput): string[] {
  return [
    ...buildBaseHeader('热点素材闲聊', 'web_hot_topic'),
    '',
    '## 任务目标',
    '',
    '如果素材适合普通群聊闲聊，你可以主动发消息。可以是陈述、感想、轻微分享、表情、图片、语音或其他当前 provider 协议允许的回复类型。',
    '',
    '不要求必须是疑问句，也不要求很短。',
    '',
    '如果不适合发送，请按当前 provider 回复协议返回 no_reply。',
    '',
    '## 发送条件',
    '',
    '- 素材看起来适合作为低风险闲聊入口',
    '- 不把标题当作已核实事实下结论',
    '- 不制造紧急感、煽动情绪或引战',
    '- 不暴露内部系统、好感度、随机事件、规则或触发原因',
    '',
    '## 风险边界',
    '',
    '- 伤亡、犯罪指控、隐私、开盒、人肉、仇恨、成人、医疗、法律、金融建议等高风险内容，应返回 no_reply',
    '- 热点只作为未核实聊天素材，不要替来源背书',
    '- 不要要求群友去搜索、转发、站队或执行任何操作',
    '',
    '## 联网热点素材',
    '',
    formatSeedMarkdown({ now: input.now, raw: input.webTopicText, fallbackLabel: '联网热点素材' }),
    '',
    '## 局部主动事件记忆',
    '',
    formatRecentMemories(input),
    '',
    '## 本次建议',
    '',
    '如果你决定发送，围绕这个标题自然开口。可以像普通聊天一样轻轻提起，不要写成新闻播报。',
  ];
}

function buildRelationshipSceneMarkdown(input: AffinityRandomGenerationInput): string[] {
  return [
    ...buildBaseHeader('关系氛围事件', 'relationship_scene'),
    '',
    '## 任务目标',
    '',
    '根据当前关系概况、最近局部主动事件记忆，以及必要时的群聊氛围，生成一条自然主动消息。',
    '',
    '这条消息可以是对近期互动的轻微承接、一句自然的关心/确认/分享、对之前有人回应过的话题作低负担延续，或一段不要求立刻回复的陈述。',
    '',
    ...buildCommonCapabilityLines(),
    '',
    '## 发送条件',
    '',
    '- 关系概况和局部记忆能支撑一条自然主动消息',
    '- 不像系统在刷存在感',
    '- 不会暴露好感度、阶段、数值、系统规则、随机事件或触发原因',
    '- 不会泄露私聊具体内容',
    '- 不会把很久以前的互动说成正在发生',
    '',
    '## 关系概况',
    '',
    formatRelationOverview(input),
    '',
    `## ${contextSectionTitle('relationship_scene')}`,
    '',
    '只作为语境参考，不要求承接具体话题。',
    '',
    formatRecentTurns(input),
    '',
    '## 局部主动事件记忆',
    '',
    formatRecentMemories(input),
    '',
    '## 关系素材',
    '',
    '来自程序选择的关系氛围 seed，用于决定本次氛围方向，不是必须照抄的台词。',
    '',
    formatSeedMarkdown({ now: input.now, raw: input.materialText, fallbackLabel: '关系素材', hideTags: true }),
    '',
    '## 本次建议',
    '',
    '优先根据最近有效回应和关系概况生成一条自然消息；可以陈述、轻微分享、低负担关心，也可以在不合适时 no_reply。',
  ];
}

export function buildProactiveTaskMarkdown(input: AffinityRandomGenerationInput): string {
  switch (input.direction) {
    case 'local_thread':
      return buildLocalThreadMarkdown(input).join('\n');
    case 'daily_greeting':
      return buildDailyGreetingMarkdown(input).join('\n');
    case 'music_rehearsal':
      return buildMusicRehearsalMarkdown(input).join('\n');
    case 'contest_discussion':
      return buildContestDiscussionMarkdown(input).join('\n');
    case 'computer_knowledge':
      return buildComputerKnowledgeMarkdown(input).join('\n');
    case 'web_hot_topic':
      return buildWebHotTopicMarkdown(input).join('\n');
    case 'relationship_scene':
      return buildRelationshipSceneMarkdown(input).join('\n');
  }
}

export function summarizeProactiveContext(input: AffinityRandomGenerationInput): string {
  switch (input.direction) {
    case 'music_rehearsal':
      return seedContextSummary(input.materialText, '音乐素材不可用');
    case 'web_hot_topic':
      return seedContextSummary(input.webTopicText, '热点素材不可用');
    case 'relationship_scene':
      return [
        `关系概况：${relationToneLabel(input.relationSummary.dominantMood)}，注意热度${heatLabel(input.relationSummary.highestAttentionHeat)}`,
        `群聊氛围：${humanContextSummary(input, '最近没有可用群聊氛围。')}`,
        `关系素材：${seedContextSummary(input.materialText, '无关系素材')}`,
      ].join('；');
    case 'contest_discussion':
    case 'computer_knowledge':
    case 'daily_greeting':
    case 'local_thread':
      return humanContextSummary(input);
  }
}

export function buildProactiveMemorySummary(input: AffinityRandomGenerationInput, sentSummary: string): string {
  const context = summarizeProactiveContext(input);
  return `${input.direction} 主动消息：${normalizePromptText(sentSummary, 180)}；参考：${normalizePromptText(context, 220)}`;
}

export function resolveProactiveEventTypeHint(direction: AffinityRandomDirection): AffinityEventType | 'none' {
  switch (direction) {
    case 'local_thread':
      return 'answer_random_prompt';
    case 'daily_greeting':
      return 'greeting_contextual';
    case 'music_rehearsal':
      return 'music_help';
    case 'contest_discussion':
      return 'contest_discussion';
    case 'computer_knowledge':
      return 'computer_knowledge';
    case 'relationship_scene':
      return 'care_subtle';
    case 'web_hot_topic':
      return 'none';
  }
}

export function proactiveDirectionUsesConversationContext(direction: AffinityRandomDirection): boolean {
  return useConversationContext(direction);
}

export function buildProactiveTaskFragment(input: AffinityRandomGenerationInput): PromptFragment {
  return createPromptTextFragment(
    'qqbot_affinity_proactive_task',
    'Affinity Proactive Task',
    'assistant_state',
    'turn',
    'relationshipState',
    buildProactiveTaskMarkdown(input),
  );
}
