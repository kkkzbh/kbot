import { describe, expect, it } from 'vitest';
import {
  chatHistoryExample,
  contextBlockGuides,
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

describe('context preset block guides', () => {
  it('explains every non-role block before it is configured', () => {
    for (const type of NON_ROLE_BLOCKS) {
      const guide = contextBlockGuides[type];
      expect(guide.summary.trim().length).toBeGreaterThan(10);
    }
  });

  it('shows the provider message shape for a recent conversation round', () => {
    expect(chatHistoryExample.messages).toEqual([
      {
        role: 'user',
        content: '[speaker_id=10001 speaker_name="小明"] 今晚几点开黑？',
      },
      {
        role: 'assistant',
        content: '八点，可以。',
      },
    ]);
  });
});
