export const VOICE_OUTPUT_LANGUAGES = ['zh', 'ja', 'en', 'auto'] as const;

export type VoiceOutputLanguage = (typeof VOICE_OUTPUT_LANGUAGES)[number];

const VOICE_OUTPUT_LANGUAGE_SET = new Set<string>(VOICE_OUTPUT_LANGUAGES);

export const VOICE_OUTPUT_LANGUAGE_LABELS: Record<VoiceOutputLanguage, string> = {
  zh: '中文',
  ja: '日语',
  en: '英语',
  auto: '自动',
};

export const VOICE_OUTPUT_LANGUAGE_NATIVE_NAMES: Record<Exclude<VoiceOutputLanguage, 'auto'>, string> = {
  zh: '中文',
  ja: '日本語',
  en: 'English',
};

export function normalizeVoiceOutputLanguage(value: unknown): VoiceOutputLanguage {
  const normalized = String(value ?? '').trim().toLowerCase();
  return VOICE_OUTPUT_LANGUAGE_SET.has(normalized) ? normalized as VoiceOutputLanguage : 'zh';
}

export function requireVoiceOutputLanguage(value: unknown): VoiceOutputLanguage {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('QQ voice output language must be configured via voiceOutputLanguage or QQ_VOICE_OUTPUT_LANGUAGE.');
  }
  if (!VOICE_OUTPUT_LANGUAGE_SET.has(normalized)) {
    throw new Error(`QQ voice output language must be one of ${VOICE_OUTPUT_LANGUAGES.join(', ')}, got ${String(value)}.`);
  }
  return normalized as VoiceOutputLanguage;
}

export function buildVoiceOutputLanguageContractLines(language: VoiceOutputLanguage): string[] {
  if (language === 'auto') {
    return [
      '- 当前语音输出目标语言：自动。',
      '- 只要选择 `voice` 输出，`voice.content` 必须使用本轮最自然的朗读语言。',
      '- 不要期待 TTS 翻译；TTS 只朗读 `voice.content`。',
      '- 普通 `message`、`structured_block` 不受此规则影响，按聊天语境正常回复。',
    ];
  }

  const label = VOICE_OUTPUT_LANGUAGE_LABELS[language];
  const nativeName = VOICE_OUTPUT_LANGUAGE_NATIVE_NAMES[language];
  return [
    `- 当前语音输出目标语言：${label}（${nativeName}，${language}）。`,
    `- 只要选择 \`voice\` 输出，\`voice.content\` 必须直接写成自然${label}。`,
    '- 不要先写另一种语言再期待 TTS 翻译；TTS 只朗读 `voice.content`。',
    '- 普通 `message`、`structured_block` 不受此规则影响，按聊天语境正常回复。',
  ];
}
