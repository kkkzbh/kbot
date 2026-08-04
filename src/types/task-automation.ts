import 'koishi';
import type { DurableDeliveryState } from './durable-delivery.js';

export type TaskScope = 'group' | 'private';
export type TaskKind = 'once' | 'cron';
export type AutomationJobStatus = 'active' | 'paused' | 'done' | 'deleted';
export type AutomationJobRunStatus = 'running' | 'succeeded' | 'failed';

export interface AutomationJob {
  id: number;
  creatorId: string;
  scope: TaskScope;
  channelId: string;
  guildId: string;
  platform: string;
  botSelfId: string;
  sourceRoomId: number;
  sourceConversationId: string | null;
  kind: TaskKind;
  runAt: number | null;
  cronExpr: string | null;
  goal: string;
  timezone: string;
  mentionCreator: number;
  event: Record<string, unknown> | null;
  status: AutomationJobStatus;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationJobRun {
  id: number;
  jobId: number;
  triggeredAt: number;
  startedAt: number;
  finishedAt: number | null;
  status: AutomationJobRunStatus;
  error: string | null;
  outputText: string | null;
  outputPayload: unknown | null;
  deliveryReceipt: string | null;
  deliveryState: DurableDeliveryState;
  deliveryAttemptId: string | null;
  deliveryConfirmedAt: number | null;
  deliveryError: string | null;
}

declare module 'koishi' {
  interface Tables {
    automation_job: AutomationJob;
    automation_job_run: AutomationJobRun;
  }
}
