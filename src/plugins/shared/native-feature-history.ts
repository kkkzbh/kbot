import type { MessageContent, MessageContentComplex } from '@langchain/core/messages';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTextPart(part: MessageContentComplex): part is MessageContentComplex & { type: 'text'; text: string } {
  return part.type === 'text' && typeof (part as { text?: unknown }).text === 'string';
}

export function stripNativeFeatureTransportMarkers(value: string): string {
  return value
    .split(/\r\n?|\n/u)
    .filter((line) => !/^\s*\[image:[^\r\n]*\]\s*$/u.test(line))
    .join('\n')
    .trim();
}

export function buildNativeFeatureAssistantHistoryText(
  summary: string,
  content: MessageContent,
): string {
  const normalizedSummary = normalizeText(summary);
  const transformedText = (typeof content === 'string'
    ? [content]
    : content.filter(isTextPart).map((part) => part.text))
    .map(stripNativeFeatureTransportMarkers)
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!transformedText) return normalizedSummary;
  if (!normalizedSummary || transformedText.includes(normalizedSummary)) return transformedText;
  return `${normalizedSummary}\n${transformedText}`;
}
