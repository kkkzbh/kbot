import { describe, expect, it } from 'vitest';
import {
  chatHistoryExample,
  configurableQqbotFragmentChannels,
  contextBlockGuides,
  qqbotFragmentRules,
  requestAttachmentHistory,
  requestAttachmentGuides,
  requestDocumentExample,
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

  it('documents the canonical request document wrapper', () => {
    expect(requestDocumentExample.role).toBe('user');
    expect(requestDocumentExample.content).toContain('<context>');
    expect(requestDocumentExample.content).toContain(
      '<doc metadata="{"source":"upload","filename":"群规.txt"}" id="doc-01">',
    );
    expect(requestDocumentExample.content).toContain('群内禁止发布账号、口令和私人联系方式。');
  });

  it('explains every attachment kind supported by the QQBot archive', () => {
    expect(requestAttachmentGuides.map((item) => item.kind)).toEqual([
      'image',
      'pdf',
      'text',
      'audio',
      'video',
      'file',
    ]);
    for (const item of requestAttachmentGuides) {
      expect(item.description.trim().length).toBeGreaterThan(30);
    }
  });

  it('explains where historical attachment context appears and how replay works', () => {
    expect(requestAttachmentHistory).toMatchObject({
      injectionName: 'read_files_context',
      stage: 'after_scratchpad',
      role: 'system',
    });
    expect(requestAttachmentHistory.projection).toContain('att_pdf01');
    expect(requestAttachmentHistory.projection).toContain('处理结果');
    expect(requestAttachmentHistory.replayCall).toContain('qqbot_attachment_replay');
    expect(requestAttachmentHistory.readCall).toContain('read_files');
  });

  it('separates mandatory QQBot fragment rules from the configurable channels', () => {
    expect(qqbotFragmentRules.map((rule) => rule.label)).toEqual([
      '生成',
      '放置',
      '排序',
      '消费',
    ]);
    expect(configurableQqbotFragmentChannels.map((channel) => channel.key)).toEqual([
      'relationshipState',
      'attachmentReferences',
      'nativeCapabilities',
    ]);
  });
});
