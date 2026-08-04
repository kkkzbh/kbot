import type { TurnInput } from '../pipeline/types.js';
import type { OutboundMessageSegment } from '../../shared/outbound/index.js';

export type ReplyRunState = 'computing' | 'computed' | 'sending';
export type ReplyRunMode = 'interrupt' | 'queue';

export class ReplyRunCancellationError extends Error {
  constructor(readonly runId: string) {
    super(`reply run ${runId} was cancelled.`);
    this.name = 'ReplyRunCancellationError';
  }
}

export interface ReplyRuntimeRoomLike {
  conversationId?: string;
  model?: string;
  [key: string]: unknown;
}

export type ReplyTurnInput = TurnInput;

export interface ReplyTurnContinuationContext {
  alreadySentText: string;
  pendingUnitTexts: string[];
  supplementalMessages: string[];
  progressVisibleLines: string[];
}

export interface ReplyRuntimePrepareResult {
  action: 'continue' | 'stop';
  run?: ReplyRuntimeRun;
  inputText?: string;
  inputTextSpeakerTagged?: boolean;
  continuationContext?: ReplyTurnContinuationContext;
}

export interface ReplyRuntimePrepareArgs {
  runId: string;
  queueKey: string;
  actorKey: string;
  conversationId?: string;
  room: ReplyRuntimeRoomLike;
  input: ReplyTurnInput;
  mode?: ReplyRunMode;
}

export interface ReplyRuntimeFirstReplyQuote {
  enabled: boolean;
  targetMessageId: string | null;
  consumed: boolean;
}

export interface ReplyRuntimeProgressState {
  visibleLines: string[];
  lastSentAt: number | null;
}

export interface ReplyRuntimeRun {
  id: string;
  queueKey: string;
  actorKey: string;
  conversationId?: string;
  room: ReplyRuntimeRoomLike;
  input: ReplyTurnInput;
  state: ReplyRunState;
  hasComputedOutput: boolean;
  cancelled: boolean;
  plannedUnitHistoryLines: string[];
  committedHistoryLines: string[];
  transientProgress: ReplyRuntimeProgressState;
  firstReplyQuote: ReplyRuntimeFirstReplyQuote;
  sendAbortController?: AbortController;
}

export interface ReplyRuntimeOptions {
  drainOutbound: (queueKey: string) => Promise<void>;
  collectWindowMs?: number;
  maxPendingInputs?: number;
}

interface ReplyRuntimeContinuationSnapshot {
  alreadySentText: string;
  pendingUnitTexts: string[];
  progressVisibleLines: string[];
  progressLastSentAt: number | null;
  hasModelOutput: boolean;
  baseInput?: ReplyTurnInput;
}

interface PendingTurnEntry {
  runId: string;
  queueKey: string;
  actorKey: string;
  conversationId?: string;
  room: ReplyRuntimeRoomLike;
  input: ReplyTurnInput;
  firstReplyQuote: ReplyRuntimeFirstReplyQuote;
  resolve: (result: ReplyRuntimePrepareResult) => void;
}

interface PendingTurnReference {
  state: ReplyRuntimePendingState;
  entry: PendingTurnEntry;
}

interface QueueModeWaiter {
  runId: string;
  cancelled: boolean;
  cancellation: Promise<void>;
  resolveCancellation: () => void;
}

interface ActiveRunCancellation {
  run: ReplyRuntimeRun;
  work: Promise<void>;
  finalized: boolean;
  finishObserved: boolean;
}

interface ReplyRuntimePendingState {
  queueKey: string;
  actorKey: string;
  snapshot: ReplyRuntimeContinuationSnapshot;
  pending: PendingTurnEntry[];
  status: 'draining' | 'cooldown' | 'queued';
  timer?: NodeJS.Timeout;
}

const DEFAULT_COLLECT_WINDOW_MS = 400;
const DEFAULT_MAX_PENDING_INPUTS = 8;

function normalizeInputText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

function formatSpeakerName(name: string): string {
  return JSON.stringify(name);
}

function formatInputWithIdentity(input: ReplyTurnInput): string {
  const text = normalizeInputText(input.text);
  if (!text) return '';
  if (input.isDirect) return text;
  return `[speaker_id=${input.userId} speaker_name=${formatSpeakerName(input.displayName)}] ${text}`;
}

function renderAggregatedInput(inputs: ReplyTurnInput[]): { text: string; speakerTagged: boolean } {
  const normalized = inputs
    .map((input) => ({
      ...input,
      text: normalizeInputText(input.text),
    }))
    .filter((input) => input.text);
  if (!normalized.length) {
    return {
      text: '',
      speakerTagged: false,
    };
  }

  const firstUserId = normalized[0].userId;
  const sameUser = normalized.every((input) => input.userId === firstUserId);
  if (sameUser) {
    return {
      text: normalized.map((input) => input.text).join('\n').trim(),
      speakerTagged: false,
    };
  }

  return {
    text: normalized.map((input) => formatInputWithIdentity(input)).filter(Boolean).join('\n').trim(),
    speakerTagged: true,
  };
}

function buildSupplementalMessages(inputs: ReplyTurnInput[]): string[] {
  return inputs.map((input) => formatInputWithIdentity(input)).filter(Boolean);
}

export class ReplyRuntime {
  private readonly currentComputeByQueueKey = new Map<string, string>();
  private readonly currentComputedByQueueKey = new Map<string, string>();
  private readonly currentSendByQueueKey = new Map<string, string>();
  private readonly activeRunByActorKey = new Map<string, string>();
  private readonly runs = new Map<string, ReplyRuntimeRun>();
  private readonly completionResolvers = new Map<string, () => void>();
  private readonly completionPromises = new Map<string, Promise<void>>();
  private readonly pendingStatesByActorKey = new Map<string, ReplyRuntimePendingState>();
  private readonly pendingTurnByRunId = new Map<string, PendingTurnReference>();
  private readonly queueModeWaiterByRunId = new Map<string, QueueModeWaiter>();
  private readonly activeCancellationByRunId = new Map<string, ActiveRunCancellation>();
  private readonly requestAbortControllerByRunId = new Map<string, AbortController>();
  private readonly requestSettlementResolvers = new Map<string, (error?: unknown) => void>();
  private readonly requestSettlementPromises = new Map<string, Promise<unknown | undefined>>();
  private readonly queueActorOrder = new Map<string, string[]>();
  private readonly collectWindowMs: number;
  private readonly maxPendingInputs: number;

  constructor(private readonly options: ReplyRuntimeOptions) {
    this.collectWindowMs = Math.max(1, Math.floor(options.collectWindowMs ?? DEFAULT_COLLECT_WINDOW_MS));
    this.maxPendingInputs = Math.max(1, Math.floor(options.maxPendingInputs ?? DEFAULT_MAX_PENDING_INPUTS));
  }

  async prepareRun(args: ReplyRuntimePrepareArgs): Promise<ReplyRuntimePrepareResult> {
    this.assertRunIdAvailable(args.runId);
    const { mode = 'interrupt' } = args;
    const firstReplyQuote = this.resolveFirstReplyQuote(args.queueKey, args.actorKey, args.input);

    if (mode === 'queue') {
      return this.prepareQueuedRun(args, firstReplyQuote);
    }

    const activeRunId = this.activeRunByActorKey.get(args.actorKey);
    const activeRun = activeRunId ? this.runs.get(activeRunId) : null;
    if (activeRun && !activeRun.cancelled) {
      const pendingState = this.getOrCreatePendingState(
        args,
        this.captureContinuationSnapshot(activeRun),
        'draining',
      );
      const pendingPromise = this.enqueuePendingTurn(pendingState, { ...args, firstReplyQuote });
      const cancellation = this.beginActiveRunCancellation(activeRun);
      try {
        await cancellation.work;
        pendingState.snapshot = this.captureContinuationSnapshot(activeRun);
      } catch (error) {
        this.stopPendingState(pendingState);
        throw error;
      } finally {
        this.finalizeActiveRunCancellation(cancellation);
      }
      if (
        this.pendingStatesByActorKey.get(pendingState.actorKey) !== pendingState
        || pendingState.pending.length === 0
      ) {
        return pendingPromise;
      }
      this.enterCooldown(pendingState);
      this.tryStartNextCompute(args.queueKey);
      return pendingPromise;
    }

    const existingPendingState = this.pendingStatesByActorKey.get(args.actorKey);
    if (existingPendingState) {
      const pendingPromise = this.enqueuePendingTurn(existingPendingState, { ...args, firstReplyQuote });
      if (existingPendingState.status === 'cooldown') {
        this.enterCooldown(existingPendingState);
      }
      return pendingPromise;
    }

    if (this.canStartCompute(args.queueKey)) {
      const run = this.createRun({ ...args, firstReplyQuote });
      return {
        action: 'continue',
        run,
        inputText: normalizeInputText(args.input.text),
        inputTextSpeakerTagged: false,
      };
    }

    const pendingState = this.getOrCreatePendingState(args, {
      alreadySentText: '',
      pendingUnitTexts: [],
      progressVisibleLines: [],
      progressLastSentAt: null,
      hasModelOutput: false,
    }, 'queued');
    const pendingPromise = this.enqueuePendingTurn(pendingState, { ...args, firstReplyQuote });
    this.enqueueActorIfMissing(args.queueKey, args.actorKey);
    this.tryStartNextCompute(args.queueKey);
    return pendingPromise;
  }

  async cancelRun(runId: string): Promise<boolean> {
    if (!runId.trim()) {
      throw new Error('reply cancellation requires a non-empty runId.');
    }

    const activeCancellation = this.activeCancellationByRunId.get(runId);
    if (activeCancellation) {
      try {
        await activeCancellation.work;
      } finally {
        this.finalizeActiveRunCancellation(activeCancellation);
      }
      return true;
    }

    const run = this.runs.get(runId);
    if (run) {
      const cancellation = this.beginActiveRunCancellation(run);
      try {
        await cancellation.work;
      } finally {
        this.finalizeActiveRunCancellation(cancellation);
      }
      return true;
    }

    const pendingTurn = this.pendingTurnByRunId.get(runId);
    if (pendingTurn) {
      this.cancelPendingTurn(pendingTurn);
      return true;
    }

    const queueWaiter = this.queueModeWaiterByRunId.get(runId);
    if (queueWaiter) {
      if (!queueWaiter.cancelled) {
        queueWaiter.cancelled = true;
        queueWaiter.resolveCancellation();
      }
      return true;
    }

    return false;
  }

  getRun(runId: string | undefined): ReplyRuntimeRun | null {
    if (!runId) return null;
    return this.runs.get(runId) ?? null;
  }

  getRequestSignal(runId: string | undefined): AbortSignal | null {
    if (!runId || !this.runs.has(runId)) return null;
    return this.requestAbortControllerByRunId.get(runId)?.signal ?? null;
  }

  markRequestSettled(runId: string | undefined, error?: unknown): boolean {
    if (!runId) return false;
    const resolve = this.requestSettlementResolvers.get(runId);
    if (!resolve) return false;
    this.requestSettlementResolvers.delete(runId);
    resolve(error);
    return true;
  }

  isCurrentRun(runId: string | undefined): boolean {
    const run = this.getRun(runId);
    if (!run || run.cancelled) return false;
    return (
      this.currentComputeByQueueKey.get(run.queueKey) === run.id ||
      this.currentComputedByQueueKey.get(run.queueKey) === run.id ||
      this.currentSendByQueueKey.get(run.queueKey) === run.id
    );
  }

  completeCompute(runId: string): boolean {
    const run = this.getRun(runId);
    if (!run || run.cancelled) return false;
    if (run.state !== 'computing') return false;
    if (this.currentComputeByQueueKey.get(run.queueKey) !== run.id) return false;

    this.currentComputeByQueueKey.delete(run.queueKey);
    run.state = 'computed';
    run.hasComputedOutput = true;
    this.currentComputedByQueueKey.set(run.queueKey, run.id);
    return true;
  }

  beginSending(runId: string): AbortSignal | null {
    const run = this.getRun(runId);
    if (!run || run.cancelled) return null;
    if (this.currentComputedByQueueKey.get(run.queueKey) !== run.id) return null;

    this.currentComputedByQueueKey.delete(run.queueKey);
    this.currentSendByQueueKey.set(run.queueKey, run.id);
    run.state = 'sending';
    run.sendAbortController = new AbortController();
    this.tryStartNextCompute(run.queueKey);
    return run.sendAbortController.signal;
  }

  setPlannedUnitHistory(runId: string, historyLines: string[]): void {
    const run = this.getRun(runId);
    if (!run) return;
    run.plannedUnitHistoryLines = historyLines.map((line) => line.trim()).filter(Boolean);
  }

  recordCommittedUnit(runId: string, historyLine: string): void {
    const run = this.getRun(runId);
    if (!run) return;
    const normalized = historyLine.trim();
    if (!normalized) return;
    run.committedHistoryLines.push(normalized);
  }

  recordProgressVisibleLine(runId: string, text: string, sentAt = Date.now()): boolean {
    const run = this.getRun(runId);
    if (!run) return false;
    const normalized = text.trim();
    if (!normalized) {
      throw new Error('reply progress visible line must not be empty.');
    }
    if (!Number.isFinite(sentAt) || sentAt < 0) {
      throw new Error('reply progress sentAt must be a non-negative finite number.');
    }
    run.transientProgress.visibleLines.push(normalized);
    run.transientProgress.lastSentAt = sentAt;
    return true;
  }

  getProgressState(runId: string | undefined): ReplyRuntimeProgressState | null {
    const run = this.getRun(runId);
    if (!run) return null;
    return {
      visibleLines: [...run.transientProgress.visibleLines],
      lastSentAt: run.transientProgress.lastSentAt,
    };
  }

  wasInterrupted(runId: string | undefined): boolean {
    const run = this.getRun(runId);
    if (!run) return true;
    if (run.cancelled) return true;
    return !this.isCurrentRun(runId) || run.sendAbortController?.signal.aborted === true;
  }

  getCommittedHistoryText(runId: string | undefined): string {
    const run = this.getRun(runId);
    if (!run) return '';
    return run.committedHistoryLines.join('\n').trim();
  }

  consumeFirstReplyQuote(runId: string | undefined, supported: boolean): string | null {
    const run = this.getRun(runId);
    if (!run) return null;
    if (run.firstReplyQuote.consumed) return null;
    run.firstReplyQuote.consumed = true;
    if (!supported || !run.firstReplyQuote.enabled) return null;
    return run.firstReplyQuote.targetMessageId;
  }

  finishRun(runId: string | undefined, requestSettlementError?: unknown): ReplyRuntimeRun | null {
    if (!runId) return null;
    const activeCancellation = this.activeCancellationByRunId.get(runId);
    const run = this.runs.get(runId) ?? activeCancellation?.run ?? null;
    if (!run) return null;
    this.markRequestSettled(runId, requestSettlementError);

    if (activeCancellation && !activeCancellation.finalized) {
      if (activeCancellation.finishObserved) return null;
      activeCancellation.finishObserved = true;
      return run;
    }

    return this.finalizeRun(run);
  }

  private finalizeRun(run: ReplyRuntimeRun): ReplyRuntimeRun {
    this.detachRunFromScheduling(run);
    if (this.runs.get(run.id) === run) this.runs.delete(run.id);
    this.requestAbortControllerByRunId.delete(run.id);
    this.requestSettlementResolvers.delete(run.id);
    this.requestSettlementPromises.delete(run.id);
    this.resolveRunCompletion(run.id);
    this.tryStartNextCompute(run.queueKey);
    return run;
  }

  private detachRunFromScheduling(run: ReplyRuntimeRun): void {
    if (this.currentComputeByQueueKey.get(run.queueKey) === run.id) {
      this.currentComputeByQueueKey.delete(run.queueKey);
    }
    if (this.currentComputedByQueueKey.get(run.queueKey) === run.id) {
      this.currentComputedByQueueKey.delete(run.queueKey);
    }
    if (this.currentSendByQueueKey.get(run.queueKey) === run.id) {
      this.currentSendByQueueKey.delete(run.queueKey);
    }
    if (this.activeRunByActorKey.get(run.actorKey) === run.id) {
      this.activeRunByActorKey.delete(run.actorKey);
    }
  }

  private createRun(args: {
    runId: string;
    queueKey: string;
    actorKey: string;
    conversationId?: string;
    room: ReplyRuntimeRoomLike;
    input: ReplyTurnInput;
    firstReplyQuote: ReplyRuntimeFirstReplyQuote;
    transientProgress?: ReplyRuntimeProgressState;
  }): ReplyRuntimeRun {
    const created: ReplyRuntimeRun = {
      id: args.runId,
      queueKey: args.queueKey,
      actorKey: args.actorKey,
      conversationId: args.conversationId,
      room: args.room,
      input: args.input,
      state: 'computing',
      hasComputedOutput: false,
      cancelled: false,
      plannedUnitHistoryLines: [],
      committedHistoryLines: [],
      transientProgress: args.transientProgress
        ? {
            visibleLines: [...args.transientProgress.visibleLines],
            lastSentAt: args.transientProgress.lastSentAt,
          }
        : {
            visibleLines: [],
            lastSentAt: null,
          },
      firstReplyQuote: { ...args.firstReplyQuote },
    };
    this.ensureCompletionTracking(args.runId);
    this.requestAbortControllerByRunId.set(args.runId, new AbortController());
    let resolveRequestSettlement: (error?: unknown) => void = () => {};
    const requestSettlement = new Promise<unknown | undefined>((resolve) => {
      resolveRequestSettlement = resolve;
    });
    this.requestSettlementResolvers.set(args.runId, resolveRequestSettlement);
    this.requestSettlementPromises.set(args.runId, requestSettlement);
    this.runs.set(args.runId, created);
    this.currentComputeByQueueKey.set(args.queueKey, args.runId);
    this.activeRunByActorKey.set(args.actorKey, args.runId);
    return created;
  }

  private captureContinuationSnapshot(run: ReplyRuntimeRun): ReplyRuntimeContinuationSnapshot {
    const alreadySentText = run.committedHistoryLines.join('\n').trim();
    const pendingUnitTexts = run.plannedUnitHistoryLines.slice(run.committedHistoryLines.length);
    return {
      alreadySentText,
      pendingUnitTexts,
      progressVisibleLines: [...run.transientProgress.visibleLines],
      progressLastSentAt: run.transientProgress.lastSentAt,
      hasModelOutput: run.hasComputedOutput || run.plannedUnitHistoryLines.length > 0,
      baseInput: run.hasComputedOutput || run.plannedUnitHistoryLines.length > 0 ? undefined : run.input,
    };
  }

  private beginActiveRunCancellation(run: ReplyRuntimeRun): ActiveRunCancellation {
    const existing = this.activeCancellationByRunId.get(run.id);
    if (existing) return existing;

    run.cancelled = true;

    let resolveWork: () => void = () => {};
    let rejectWork: (error: unknown) => void = () => {};
    const work = new Promise<void>((resolve, reject) => {
      resolveWork = resolve;
      rejectWork = reject;
    });
    const cancellation: ActiveRunCancellation = {
      run,
      work,
      finalized: false,
      finishObserved: false,
    };
    this.activeCancellationByRunId.set(run.id, cancellation);

    void this.performActiveRunCancellation(run).then(resolveWork, rejectWork);
    return cancellation;
  }

  private async performActiveRunCancellation(run: ReplyRuntimeRun): Promise<void> {
    const requestAbortController = this.requestAbortControllerByRunId.get(run.id);
    if (!requestAbortController) {
      throw new Error(`reply run ${run.id} has no request cancellation owner.`);
    }
    requestAbortController.abort(new ReplyRunCancellationError(run.id));
    run.sendAbortController?.abort();

    const requestSettlement = this.requestSettlementPromises.get(run.id);
    if (!requestSettlement) {
      throw new Error(`reply run ${run.id} has no request settlement owner.`);
    }
    const [, settlementError] = await Promise.all([
      this.options.drainOutbound(run.queueKey),
      requestSettlement,
    ]);
    if (settlementError != null) {
      throw settlementError;
    }
  }

  private finalizeActiveRunCancellation(cancellation: ActiveRunCancellation): void {
    if (cancellation.finalized) return;
    cancellation.finalized = true;
    if (this.activeCancellationByRunId.get(cancellation.run.id) === cancellation) {
      this.activeCancellationByRunId.delete(cancellation.run.id);
    }
    this.finalizeRun(cancellation.run);
  }

  private async prepareQueuedRun(
    args: ReplyRuntimePrepareArgs,
    firstReplyQuote: ReplyRuntimeFirstReplyQuote,
  ): Promise<ReplyRuntimePrepareResult> {
    let resolveCancellation: () => void = () => {};
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const waiter: QueueModeWaiter = {
      runId: args.runId,
      cancelled: false,
      cancellation,
      resolveCancellation,
    };
    this.queueModeWaiterByRunId.set(args.runId, waiter);

    try {
      while (!waiter.cancelled) {
        const blockingRunId = this.getBlockingRunId(args.queueKey);
        if (!blockingRunId) break;
        await Promise.race([
          this.waitForRunCompletion(blockingRunId),
          waiter.cancellation,
        ]);
      }

      if (waiter.cancelled) return { action: 'stop' };

      this.queueModeWaiterByRunId.delete(args.runId);
      const run = this.createRun({ ...args, firstReplyQuote });
      return {
        action: 'continue',
        run,
        inputText: normalizeInputText(args.input.text),
        inputTextSpeakerTagged: false,
      };
    } finally {
      if (this.queueModeWaiterByRunId.get(args.runId) === waiter) {
        this.queueModeWaiterByRunId.delete(args.runId);
      }
    }
  }

  private getOrCreatePendingState(
    args: {
      queueKey: string;
      actorKey: string;
    },
    snapshot: ReplyRuntimeContinuationSnapshot,
    status: ReplyRuntimePendingState['status'],
  ): ReplyRuntimePendingState {
    const existing = this.pendingStatesByActorKey.get(args.actorKey);
    if (existing) {
      existing.status = status;
      return existing;
    }

    const state: ReplyRuntimePendingState = {
      queueKey: args.queueKey,
      actorKey: args.actorKey,
      snapshot,
      pending: [],
      status,
    };
    this.pendingStatesByActorKey.set(args.actorKey, state);
    return state;
  }

  private enqueuePendingTurn(
    state: ReplyRuntimePendingState,
    args: {
      runId: string;
      queueKey: string;
      actorKey: string;
      conversationId?: string;
      room: ReplyRuntimeRoomLike;
      input: ReplyTurnInput;
      firstReplyQuote?: ReplyRuntimeFirstReplyQuote;
    },
  ): Promise<ReplyRuntimePrepareResult> {
    if (state.pending.length >= this.maxPendingInputs) {
      throw new Error(`reply turn pending input overflow: ${args.actorKey}`);
    }

    return new Promise<ReplyRuntimePrepareResult>((resolve) => {
      const entry: PendingTurnEntry = {
        runId: args.runId,
        queueKey: args.queueKey,
        actorKey: args.actorKey,
        conversationId: args.conversationId,
        room: args.room,
        input: args.input,
        firstReplyQuote: { ...(args.firstReplyQuote ?? this.resolveFirstReplyQuote(args.queueKey, args.actorKey, args.input)) },
        resolve,
      };
      state.pending.push(entry);
      this.pendingTurnByRunId.set(args.runId, { state, entry });
    });
  }

  private cancelPendingTurn(reference: PendingTurnReference): void {
    const { state, entry } = reference;
    const index = state.pending.indexOf(entry);
    if (index < 0) return;

    state.pending.splice(index, 1);
    this.resolvePendingTurn(entry, { action: 'stop' });
    if (state.pending.length > 0) return;

    this.stopPendingState(state);
    this.tryStartNextCompute(state.queueKey);
  }

  private resolvePendingTurn(entry: PendingTurnEntry, result: ReplyRuntimePrepareResult): void {
    const reference = this.pendingTurnByRunId.get(entry.runId);
    if (reference?.entry === entry) {
      this.pendingTurnByRunId.delete(entry.runId);
    }
    entry.resolve(result);
  }

  private enterCooldown(state: ReplyRuntimePendingState): void {
    state.status = 'cooldown';
    this.removeActorFromQueue(state.queueKey, state.actorKey);
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.status = 'queued';
      this.enqueueActorIfMissing(state.queueKey, state.actorKey);
      this.tryStartNextCompute(state.queueKey);
    }, this.collectWindowMs);
  }

  private stopPendingState(state: ReplyRuntimePendingState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (this.pendingStatesByActorKey.get(state.actorKey) === state) {
      this.pendingStatesByActorKey.delete(state.actorKey);
    }
    this.removeActorFromQueue(state.queueKey, state.actorKey);
    const pending = state.pending.splice(0);
    for (const entry of pending) this.resolvePendingTurn(entry, { action: 'stop' });
  }

  private canStartCompute(queueKey: string): boolean {
    return !this.currentComputeByQueueKey.has(queueKey) && !this.currentComputedByQueueKey.has(queueKey);
  }

  private tryStartNextCompute(queueKey: string): void {
    if (!this.canStartCompute(queueKey)) return;

    const queue = this.getQueue(queueKey);
    while (queue.length > 0) {
      const actorKey = queue[0];
      const state = this.pendingStatesByActorKey.get(actorKey);
      if (!state || state.queueKey !== queueKey) {
        queue.shift();
        continue;
      }
      if (state.status !== 'queued') {
        return;
      }
      this.startPendingState(state);
      return;
    }
  }

  private startPendingState(state: ReplyRuntimePendingState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.pendingStatesByActorKey.delete(state.actorKey);
    this.removeActorFromQueue(state.queueKey, state.actorKey);

    if (!state.pending.length) {
      this.tryStartNextCompute(state.queueKey);
      return;
    }

    const pending = state.pending.splice(0);
    const carrier = pending[pending.length - 1];
    const earlier = pending.slice(0, -1);
    earlier.forEach((entry) => this.resolvePendingTurn(entry, { action: 'stop' }));

    const hasContinuationContext = state.snapshot.hasModelOutput
      || state.snapshot.progressVisibleLines.length > 0;
    const continuationContext = hasContinuationContext
      ? {
          alreadySentText: state.snapshot.alreadySentText,
          pendingUnitTexts: [...state.snapshot.pendingUnitTexts],
          supplementalMessages: state.snapshot.hasModelOutput
            ? buildSupplementalMessages(earlier.map((entry) => entry.input))
            : [],
          progressVisibleLines: [...state.snapshot.progressVisibleLines],
        }
      : undefined;
    const aggregatedInputs = [
      ...(state.snapshot.baseInput ? [state.snapshot.baseInput] : []),
      ...pending.map((entry) => entry.input),
    ];
    const aggregatedInput = state.snapshot.hasModelOutput
      ? {
          text: normalizeInputText(carrier.input.text),
          speakerTagged: false,
        }
      : renderAggregatedInput(aggregatedInputs);
    const effectiveInput: ReplyTurnInput = state.snapshot.hasModelOutput
      ? {
          ...carrier.input,
          imageParts: pending.flatMap((entry) => entry.input.imageParts),
          hasVoiceInput: pending.some((entry) => entry.input.hasVoiceInput),
          hasImageInput: pending.some((entry) => entry.input.imageParts.length > 0),
          imageCount: pending.reduce((total, entry) => total + entry.input.imageParts.length, 0),
        }
      : {
          ...carrier.input,
          text: aggregatedInput.text,
          imageParts: aggregatedInputs.flatMap((input) => input.imageParts),
          hasVoiceInput: aggregatedInputs.some((input) => input.hasVoiceInput),
          hasImageInput: aggregatedInputs.some((input) => input.imageParts.length > 0),
          imageCount: aggregatedInputs.reduce((total, input) => total + input.imageParts.length, 0),
        };
    const run = this.createRun({
      runId: carrier.runId,
      queueKey: carrier.queueKey,
      actorKey: carrier.actorKey,
      conversationId: carrier.conversationId,
      room: carrier.room,
      input: effectiveInput,
      firstReplyQuote: carrier.firstReplyQuote,
      transientProgress: {
        visibleLines: [...state.snapshot.progressVisibleLines],
        lastSentAt: state.snapshot.progressLastSentAt,
      },
    });

    this.resolvePendingTurn(carrier, {
      action: 'continue',
      run,
      inputText: aggregatedInput.text,
      inputTextSpeakerTagged: aggregatedInput.speakerTagged,
      continuationContext,
    });
  }

  private ensureCompletionTracking(runId: string): void {
    if (this.completionPromises.has(runId)) return;
    let resolve: () => void = () => {};
    const promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve;
    });
    this.completionResolvers.set(runId, resolve);
    this.completionPromises.set(runId, promise);
  }

  private resolveRunCompletion(runId: string): void {
    this.completionResolvers.get(runId)?.();
    this.completionResolvers.delete(runId);
    this.completionPromises.delete(runId);
  }

  private assertRunIdAvailable(runId: string): void {
    if (!runId.trim()) {
      throw new Error('reply runtime requires a non-empty runId.');
    }
    if (
      this.runs.has(runId)
      || this.pendingTurnByRunId.has(runId)
      || this.queueModeWaiterByRunId.has(runId)
      || this.activeCancellationByRunId.has(runId)
    ) {
      throw new Error(`reply runtime runId is already active: ${runId}`);
    }
  }

  private async waitForRunCompletion(runId: string): Promise<void> {
    await this.completionPromises.get(runId);
  }

  private getBlockingRunId(queueKey: string): string | null {
    return (
      this.currentComputeByQueueKey.get(queueKey) ??
      this.currentComputedByQueueKey.get(queueKey) ??
      this.currentSendByQueueKey.get(queueKey) ??
      null
    );
  }

  private getQueue(queueKey: string): string[] {
    const existing = this.queueActorOrder.get(queueKey);
    if (existing) return existing;

    const created: string[] = [];
    this.queueActorOrder.set(queueKey, created);
    return created;
  }

  private enqueueActorIfMissing(queueKey: string, actorKey: string): void {
    const queue = this.getQueue(queueKey);
    if (queue.includes(actorKey)) return;
    queue.push(actorKey);
  }

  private removeActorFromQueue(queueKey: string, actorKey: string): void {
    const queue = this.getQueue(queueKey);
    const nextQueue = queue.filter((key) => key !== actorKey);
    if (nextQueue.length === 0) {
      this.queueActorOrder.delete(queueKey);
      return;
    }
    this.queueActorOrder.set(queueKey, nextQueue);
  }

  private resolveFirstReplyQuote(
    queueKey: string,
    actorKey: string,
    input: ReplyTurnInput,
  ): ReplyRuntimeFirstReplyQuote {
    const targetMessageId = typeof input.messageId === 'string' && input.messageId.trim() ? input.messageId.trim() : null;
    if (input.isDirect || !targetMessageId) {
      return {
        enabled: false,
        targetMessageId,
        consumed: false,
      };
    }

    const activeActors = new Set<string>();
    for (const [activeActorKey, runId] of this.activeRunByActorKey.entries()) {
      const run = this.runs.get(runId);
      if (!run || run.queueKey !== queueKey || run.cancelled) continue;
      activeActors.add(activeActorKey);
    }
    for (const pendingState of this.pendingStatesByActorKey.values()) {
      if (pendingState.queueKey !== queueKey) continue;
      activeActors.add(pendingState.actorKey);
    }
    activeActors.add(actorKey);

    return {
      enabled: activeActors.size >= 2,
      targetMessageId,
      consumed: false,
    };
  }
}

export function cloneSegment(segment: OutboundMessageSegment): OutboundMessageSegment {
  return { ...segment };
}
