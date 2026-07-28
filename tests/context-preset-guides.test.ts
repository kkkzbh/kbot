import { describe, expect, it } from 'vitest';
import {
  chatHistoryExample,
  contextBlockGuides,
  requestAttachmentExamples,
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
      expect(item.route.trim().length).toBeGreaterThan(10);
      expect(item.modelView.trim().length).toBeGreaterThan(10);
      expect(item.usage.trim().length).toBeGreaterThan(10);
      expect(item.boundary.trim().length).toBeGreaterThan(10);
    }
  });

  it('shows current and historical attachment message shapes', () => {
    expect(requestAttachmentExamples.map((example) => example.role)).toEqual([
      'user',
      'system',
    ]);
    expect(requestAttachmentExamples[0]?.content).toContain('"type": "image_url"');
    expect(requestAttachmentExamples[0]?.content).toContain('"type": "file_url"');
    expect(requestAttachmentExamples[1]?.content).toContain('qqbot_attachment_replay');
    expect(requestAttachmentExamples[1]?.content).toContain('可回放=file_url');
  });
});
