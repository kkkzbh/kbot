import { describe, expect, it } from 'vitest';
import {
  contextBlockGuides,
  supportsBudgetOrder,
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

  it('only offers budget ordering for blocks consumed by the allocator', () => {
    expect(supportsBudgetOrder('chatHistory')).toBe(true);
    expect(supportsBudgetOrder('requestDocuments')).toBe(true);
    expect(supportsBudgetOrder('lore')).toBe(true);
    expect(supportsBudgetOrder('authorsNote')).toBe(true);
    expect(supportsBudgetOrder('knowledge')).toBe(true);
    expect(supportsBudgetOrder('agentScratchpad')).toBe(false);
    expect(supportsBudgetOrder('currentInput')).toBe(false);
    expect(supportsBudgetOrder('modelOutput')).toBe(false);
  });
});
