import { CallbackManager } from '@langchain/core/callbacks/manager';
import type { Session } from 'koishi';

export const CHATLUNA_AGENT_EVENT = 'chatluna-agent-event';

type AgentAction = { tool: string };
type AgentStep = { action: AgentAction; observation: unknown };
export type AgentEvent =
  | { type: 'tool-call'; actions: AgentAction[] }
  | { type: 'tool-result'; steps: AgentStep[] }
  | { type: 'human-update' }
  | { type: 'round-decision'; canContinue?: boolean }
  | { type: 'done' };

interface AgentCallbackEvent {
  context?: {
    kind?: 'main' | 'subagent';
    requestId?: string;
  };
  event: AgentEvent;
}

export type ChatCallbacksProviderLike = (input: {
  session: Session;
  conversation: { id?: unknown };
  requestId: string;
}) => ReturnType<typeof CallbackManager.fromHandlers> | undefined;

export type AgentProgressCallbacksProvider = ChatCallbacksProviderLike & {
  disposeRun: (replyRunId: string) => void;
  dispose: () => void;
};

export type ProgressActivity = 'search' | 'memory' | 'reading' | 'action' | 'work';

type ProgressPhraseKind = `start:${ProgressActivity}` | `wait:${ProgressActivity}` | `continue:${ProgressActivity}`;

const PROGRESS_PHRASES: Record<ProgressPhraseKind, readonly string[]> = {
  'start:search': ['我搜一下。', '等我查一下。', '我去翻翻看。'],
  'start:memory': ['让我想想。', '我翻一下之前的记录。', '等等，我回忆一下。'],
  'start:reading': ['我先看看这个。', '等我读一下。', '我看一眼里面写了什么。'],
  'start:action': ['我先弄一下。', '等我处理一下。', '我来试试。'],
  'start:work': ['等我一下。', '我看看怎么回事。', '我先理一理。'],
  'wait:search': ['我还在找，再等我一下。', '我还在查。'],
  'wait:memory': ['我还在翻之前的记录。', '我还在回想。'],
  'wait:reading': ['我还在看。', '我还没读完，再等我一下。'],
  'wait:action': ['还在处理，稍等我一下。', '我还在弄。'],
  'wait:work': ['还在弄，稍等我一下。', '我还在处理。'],
  'continue:search': ['我接着查一下。', '我再核对一下。'],
  'continue:memory': ['我再翻一下记录。', '我接着理一下。'],
  'continue:reading': ['我接着看。', '我再核对一下内容。'],
  'continue:action': ['我接着处理。', '我再确认一下。'],
  'continue:work': ['我接着弄。', '我再理一下。'],
};

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function classifyToolName(toolName: string): ProgressActivity {
  const normalized = toolName.trim().toLowerCase();
  if (/(?:web|search|fetch|weather|browser|url|http)/u.test(normalized)) return 'search';
  if (/(?:memory|history|context|recall)/u.test(normalized)) return 'memory';
  if (/(?:read|grep|glob|document|attachment|file_view)/u.test(normalized)) return 'reading';
  if (/(?:write|edit|publish|bash|command|automation|trigger|create|update|delete|pause|resume)/u.test(normalized)) {
    return 'action';
  }
  return 'work';
}

function classifyActions(event: Extract<AgentEvent, { type: 'tool-call' }>): ProgressActivity {
  const categories = event.actions
    .filter((action) => !action.tool.endsWith('_Exception'))
    .map((action) => classifyToolName(action.tool));
  if (categories.includes('search')) return 'search';
  if (categories.includes('memory')) return 'memory';
  if (categories.includes('reading')) return 'reading';
  if (categories.includes('action')) return 'action';
  return 'work';
}

export class ProgressPhraseBook {
  private readonly recentByConversation = new Map<string, string[]>();

  constructor(private readonly maxConversations = 512) {
    if (!Number.isSafeInteger(maxConversations) || maxConversations < 1) {
      throw new Error('progress phrase book maxConversations must be a positive safe integer.');
    }
  }

  pick(kind: ProgressPhraseKind, conversationKey: string, seed: string): string {
    const phrases = PROGRESS_PHRASES[kind];
    const recent = this.recentByConversation.get(conversationKey) ?? [];
    const candidates = phrases.filter((phrase) => !recent.includes(phrase));
    const pool = candidates.length > 0 ? candidates : phrases;
    const phrase = pool[hashSeed(`${seed}:${kind}`) % pool.length]!;
    const nextRecent = [...recent.filter((item) => item !== phrase), phrase].slice(-6);
    this.recentByConversation.delete(conversationKey);
    this.recentByConversation.set(conversationKey, nextRecent);
    while (this.recentByConversation.size > this.maxConversations) {
      const oldest = this.recentByConversation.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recentByConversation.delete(oldest);
    }
    return phrase;
  }
}

export interface AgentProgressRunOptions {
  conversationKey: string;
  requestId: string;
  phraseBook: ProgressPhraseBook;
  send: (text: string) => Promise<boolean>;
  initialState?: AgentProgressInitialState;
  now?: () => number;
  continuationDelayMs?: number;
  waitUpdateDelayMs?: number;
  maxMessages?: number;
  onBackgroundError?: (error: unknown) => void;
}

export interface AgentProgressInitialState {
  messageCount: number;
  lastMessageAt: number;
}

export class AgentProgressRun {
  private readonly now: () => number;
  private readonly continuationDelayMs: number;
  private readonly maxMessages: number;
  private readonly waitUpdateDelayMs: number;
  private messageCount: number;
  private sequence: number;
  private lastMessageAt: number;
  private lastActivity: ProgressActivity = 'work';
  private hadToolResult = false;
  private waitTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly options: AgentProgressRunOptions) {
    this.now = options.now ?? Date.now;
    this.continuationDelayMs = options.continuationDelayMs ?? 4_500;
    this.waitUpdateDelayMs = options.waitUpdateDelayMs ?? 8_000;
    this.maxMessages = options.maxMessages ?? 2;
    const initialState = options.initialState ?? {
      messageCount: 0,
      lastMessageAt: 0,
    };
    if (
      !Number.isSafeInteger(initialState.messageCount)
      || initialState.messageCount < 0
      || initialState.messageCount > this.maxMessages
    ) {
      throw new Error('agent progress initial messageCount is outside the configured message budget.');
    }
    if (!Number.isFinite(initialState.lastMessageAt) || initialState.lastMessageAt < 0) {
      throw new Error('agent progress initial lastMessageAt must be a non-negative finite number.');
    }
    this.messageCount = initialState.messageCount;
    this.sequence = initialState.messageCount;
    this.lastMessageAt = initialState.lastMessageAt;
  }

  async onAgentEvent(event: AgentEvent): Promise<void> {
    if (this.disposed) return;
    if (event.type === 'tool-call') {
      if (event.actions.every((action) => action.tool.endsWith('_Exception'))) return;
      const activity = classifyActions(event);
      this.lastActivity = activity;
      if (this.messageCount === 0) {
        await this.emit(`start:${activity}`);
      }
      this.armWaitUpdate();
      return;
    }

    if (event.type === 'tool-result') {
      this.clearWaitUpdate();
      this.hadToolResult = event.steps.length > 0;
      return;
    }

    if (event.type === 'done' || event.type === 'human-update') {
      this.clearWaitUpdate();
      return;
    }

    if (
      event.type === 'round-decision'
      && event.canContinue === true
      && this.hadToolResult
      && this.messageCount > 0
      && this.messageCount < this.maxMessages
      && this.now() - this.lastMessageAt >= this.continuationDelayMs
    ) {
      this.hadToolResult = false;
      await this.emit(`continue:${this.lastActivity}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearWaitUpdate();
  }

  private async emit(kind: ProgressPhraseKind): Promise<boolean> {
    const phrase = this.options.phraseBook.pick(
      kind,
      this.options.conversationKey,
      `${this.options.requestId}:${this.sequence}`,
    );
    this.sequence += 1;
    const sent = await this.options.send(phrase);
    if (!sent) return false;
    this.messageCount += 1;
    this.lastMessageAt = this.now();
    return true;
  }

  private armWaitUpdate(): void {
    this.clearWaitUpdate();
    if (this.disposed) return;
    if (this.messageCount >= this.maxMessages) return;
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null;
      void this.emit(`wait:${this.lastActivity}`).catch((error) => {
        this.options.onBackgroundError?.(error);
      });
    }, this.waitUpdateDelayMs);
  }

  private clearWaitUpdate(): void {
    if (!this.waitTimer) return;
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }
}

function isAgentReplySession(session: { platform?: string; state?: unknown }): boolean {
  if (session.platform !== 'onebot') return false;
  const state = session.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const reply = (state as { qqReplyV2?: unknown }).qqReplyV2;
  return Boolean(reply && typeof reply === 'object' && (reply as { route?: unknown }).route === 'agent');
}

export function createAgentProgressCallbacksProvider(args: {
  phraseBook?: ProgressPhraseBook;
  resolveReplyRunId: (session: Session) => string | undefined;
  resolveInitialState: (replyRunId: string) => AgentProgressInitialState;
  send: (input: {
    session: Session;
    replyRunId: string;
    text: string;
  }) => Promise<boolean>;
  onAgentEvent?: (input: { replyRunId: string; event: AgentEvent }) => void | Promise<void>;
  onSendError?: (error: unknown, text: string) => void;
}): AgentProgressCallbacksProvider {
  const phraseBook = args.phraseBook ?? new ProgressPhraseBook();
  const activeRuns = new Map<string, Set<AgentProgressRun>>();

  const releaseRun = (replyRunId: string, run: AgentProgressRun): void => {
    run.dispose();
    const runs = activeRuns.get(replyRunId);
    if (!runs) return;
    runs.delete(run);
    if (runs.size === 0) activeRuns.delete(replyRunId);
  };

  const provider = (({ session, conversation, requestId }) => {
    if (!isAgentReplySession(session)) return undefined;
    const conversationKey = String(conversation.id ?? '').trim();
    const replyRunId = args.resolveReplyRunId(session);
    if (!conversationKey || !requestId.trim() || !replyRunId) return undefined;

    const run = new AgentProgressRun({
      conversationKey,
      requestId,
      phraseBook,
      initialState: args.resolveInitialState(replyRunId),
      send: async (text) => {
        try {
          return await args.send({ session, replyRunId, text });
        } catch (error) {
          args.onSendError?.(error, text);
          return false;
        }
      },
    });
    const runs = activeRuns.get(replyRunId) ?? new Set<AgentProgressRun>();
    runs.add(run);
    activeRuns.set(replyRunId, runs);

    return CallbackManager.fromHandlers({
      handleCustomEvent: async (name, rawPayload) => {
        if (name !== CHATLUNA_AGENT_EVENT) return;
        const payload = rawPayload as AgentCallbackEvent;
        if (!payload?.event) return;
        if (payload.context?.kind !== 'main') return;
        if (payload.context.requestId !== requestId) return;
        const terminal = payload.event.type === 'done' || payload.event.type === 'human-update';
        try {
          await args.onAgentEvent?.({ replyRunId, event: payload.event });
          await run.onAgentEvent(payload.event);
        } finally {
          if (terminal) releaseRun(replyRunId, run);
        }
      },
    });
  }) as AgentProgressCallbacksProvider;

  provider.disposeRun = (replyRunId) => {
    const runs = activeRuns.get(replyRunId);
    if (!runs) return;
    for (const run of runs) run.dispose();
    activeRuns.delete(replyRunId);
  };
  provider.dispose = () => {
    for (const runs of activeRuns.values()) {
      for (const run of runs) run.dispose();
    }
    activeRuns.clear();
  };
  return provider;
}
