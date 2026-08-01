import { describe, expect, it } from 'vitest';
import {
  chatHistoryExample,
  configurableQqbotFragmentChannels,
  contextBlockGuides,
  requestDocumentExample,
  skillDescriptionExample,
  type ContextPayloadExample,
  type GuidedContextBlockType,
} from '../apps/admin-web/src/pages/context-preset-guides';

const NON_ROLE_BLOCKS: GuidedContextBlockType[] = [
  'chatHistory',
  'requestDocuments',
  'lore',
  'authorsNote',
  'knowledge',
  'currentInput',
  'agentScratchpad',
  'modelOutput',
  'qqbotFragments',
  'toolDefinitions',
];

function messagePayload(
  example: ContextPayloadExample,
): Array<{ role: string; content: unknown }> {
  if (!Array.isArray(example.value)) throw new Error('Expected a message array payload.');
  return example.value as Array<{ role: string; content: unknown }>;
}

describe('context preset block guides', () => {
  it('explains every non-role block before it is configured', () => {
    for (const type of NON_ROLE_BLOCKS) {
      const guide = contextBlockGuides[type];
      expect(guide.placement.trim().length).toBeGreaterThan(3);
      expect(guide.summary.trim().length).toBeGreaterThan(10);
    }
  });

  it('shows the provider message shape for a recent conversation round', () => {
    const messages = messagePayload(chatHistoryExample);
    expect(chatHistoryExample.meta).toBe('messages[4]');
    expect(chatHistoryExample.roles).toEqual(['human', 'ai']);
    expect(messages.map((message) => message.role)).toEqual(['human', 'ai', 'human', 'ai']);
    expect(String(messages[0]?.content)).toContain('[speaker_id=10001 speaker_name="小明"]');
    expect(String(messages[3]?.content)).toContain('禁止发布账号、口令和私人联系方式');
  });

  it('documents the canonical request document wrapper', () => {
    const [message] = messagePayload(requestDocumentExample);
    expect(message?.role).toBe('human');
    expect(message?.content).toEqual(expect.any(String));
    const content = String(message?.content);
    expect(content).toContain('<context>');
    expect(content).toContain(
      '<doc metadata="{"source":"upload","filename":"群规.txt"}" id="doc-01">',
    );
    expect(content).toContain('群内禁止发布账号、口令和私人联系方式。');
  });

  it('keeps the description-mode Skill input shape literal', () => {
    expect(skillDescriptionExample).toContain('<available_skills>');
    expect(skillDescriptionExample).toContain('<name>web-research</name>');
    expect(skillDescriptionExample).toContain('</available_skills>');
  });

  it('exposes the configurable QQBot runtime fragments', () => {
    expect(configurableQqbotFragmentChannels.map((channel) => channel.key)).toEqual([
      'relationshipState',
      'attachmentReferences',
      'nativeCapabilities',
    ]);
  });
});
