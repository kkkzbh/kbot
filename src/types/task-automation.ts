import 'koishi';

export type TaskScope = 'group' | 'private';
export type TaskKind = 'once' | 'cron';
export type TaskStatus = 'active' | 'paused' | 'done' | 'deleted';

export interface AutomationTask {
  id: number;
  creatorId: string;
  scope: TaskScope;
  channelId: string;
  guildId: string;
  platform: string;
  botSelfId: string;
  kind: TaskKind;
  runAt: number | null;
  cronExpr: string | null;
  message: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

declare module 'koishi' {
  interface Tables {
    automation_task: AutomationTask;
  }
}
