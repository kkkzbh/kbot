import 'koishi';
import type { Session } from 'koishi';

export type GroupSummarySelectionMode = 'automatic' | 'manual';
export type GroupSummaryTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export class GroupSummaryError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid_range' | 'no_messages' | 'storage' | 'model',
    readonly operation: string,
    readonly stage: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'GroupSummaryError';
  }
}

export interface GroupSummaryEvidenceItem {
  content: string;
  evidenceMessageIds: number[];
}

export interface GroupSummaryInstitution {
  name: string;
  program: string | null;
  details: string[];
  deadlines: string[];
  requirements: string[];
  evidenceMessageIds: number[];
}

export interface GroupSummaryDocument {
  headline: string;
  institutions: GroupSummaryInstitution[];
  materials: GroupSummaryEvidenceItem[];
  experiences: GroupSummaryEvidenceItem[];
  actionItems: Array<GroupSummaryEvidenceItem & { deadline: string | null }>;
  openQuestions: GroupSummaryEvidenceItem[];
  conflicts: GroupSummaryEvidenceItem[];
  otherTopicsBrief: string;
}

export interface GroupSummaryGroupPatch {
  enabled: boolean;
  roomName: string | null;
  promptOverride: string | null;
}

export interface GroupSummaryPreviewInput {
  mode: GroupSummarySelectionMode;
  startAt?: number;
  endAt?: number;
  firstMessageId?: number;
  lastMessageId?: number;
}

export interface GroupSummaryServiceLike {
  capture(session: Session): Promise<boolean>;
  getAdminState(knownGroups?: Array<{ groupId: string; roomName: string }>): Promise<unknown>;
  getGroupDetail(groupId: string): Promise<unknown>;
  listMessages(groupId: string, page: number, pageSize: number): Promise<unknown>;
  updateGlobalPrompt(prompt: string): Promise<unknown>;
  updateGroup(groupId: string, patch: GroupSummaryGroupPatch): Promise<unknown>;
  preview(groupId: string, input: GroupSummaryPreviewInput): Promise<unknown>;
  createTask(groupId: string, input: GroupSummaryPreviewInput): Promise<unknown>;
  getTask(taskId: number): Promise<unknown>;
  clearGroup(groupId: string): Promise<{ ok: true; groupId: string }>;
}

declare module 'koishi' {
  interface Context {
    groupSummary?: GroupSummaryServiceLike;
  }
}
