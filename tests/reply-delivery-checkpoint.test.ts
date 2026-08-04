import { describe, expect, it, vi } from 'vitest';
import {
  REPLY_DELIVERY_CHECKPOINT_TABLE,
  ReplyDeliveryCheckpointStore,
  type ReplyDeliveryCheckpointDatabase,
  type ReplyDeliveryCheckpointRecord,
  type ReplyDeliveryPlannedUnit,
} from '../src/plugins/reply/delivery/checkpoint-store.js';
import { recoverReplyDeliveryCheckpoints } from '../src/plugins/reply/delivery/recovery.js';

function createDatabase(): ReplyDeliveryCheckpointDatabase & {
  rows: Map<string, ReplyDeliveryCheckpointRecord>;
} {
  const rows = new Map<string, ReplyDeliveryCheckpointRecord>();
  return {
    rows,
    async get(table, query) {
      expect(table).toBe(REPLY_DELIVERY_CHECKPOINT_TABLE);
      return [...rows.values()]
        .filter((record) => Object.entries(query).every(([key, value]) => record[key as keyof typeof record] === value))
        .map((record) => ({ ...record }));
    },
    async upsert(table, records) {
      expect(table).toBe(REPLY_DELIVERY_CHECKPOINT_TABLE);
      for (const record of records) rows.set(record.requestId, { ...record });
    },
    async set(table, query, update) {
      expect(table).toBe(REPLY_DELIVERY_CHECKPOINT_TABLE);
      const record = rows.get(query.requestId);
      if (!record) throw new Error(`missing checkpoint ${query.requestId}`);
      Object.assign(record, update);
    },
    async remove(table, query) {
      expect(table).toBe(REPLY_DELIVERY_CHECKPOINT_TABLE);
      rows.delete(query.requestId);
    },
  };
}

function plannedUnits(): ReplyDeliveryPlannedUnit[] {
  return [
    {
      index: 0,
      kind: 'text-line',
      payload: { content: '第一句' },
      historyText: '第一句',
      persistToHistory: true,
    },
    {
      index: 1,
      kind: 'text-line',
      payload: { content: '第二句' },
      historyText: '第二句',
      persistToHistory: true,
    },
  ];
}

describe('interactive reply delivery checkpoints', () => {
  it('removes an undelivered model tail after a restart without treating it as a reply', async () => {
    const database = createDatabase();
    const storeBeforeCrash = new ReplyDeliveryCheckpointStore(database, () => 100);
    const checkpoint = await storeBeforeCrash.beginRequest('request-1', 'conversation-1');
    await storeBeforeCrash.markRequestBoundaryPersisted(checkpoint);

    const reconcileHistory = vi.fn(async (input) => ({
      requestBoundaryFound: input.requestId === 'request-1',
    }));
    const storeAfterRestart = new ReplyDeliveryCheckpointStore(database, () => 200);
    const result = await recoverReplyDeliveryCheckpoints({
      store: storeAfterRestart,
      reconcileHistory,
    });

    expect(reconcileHistory).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      requestId: 'request-1',
      confirmedVisibleText: '',
      requestDisposition: 'retain_request',
      allowMissingBoundary: false,
    });
    expect(result).toEqual({ scanned: 1, reconciled: 1, outcomeUnknown: 0 });
    expect(database.rows.has('request-1')).toBe(false);
  });

  it('materializes only the first confirmed unit and never resumes an in-flight second send', async () => {
    const database = createDatabase();
    const storeBeforeCrash = new ReplyDeliveryCheckpointStore(database, () => 100);
    const checkpoint = await storeBeforeCrash.beginRequest('request-2', 'conversation-2');
    await storeBeforeCrash.markRequestBoundaryPersisted(checkpoint);
    await storeBeforeCrash.setPlannedUnits(checkpoint, plannedUnits());
    await storeBeforeCrash.beginUnit(checkpoint, 0);
    await storeBeforeCrash.confirmUnit(checkpoint, plannedUnits()[0], ['message-1']);
    await storeBeforeCrash.beginUnit(checkpoint, 1);

    const reconcileHistory = vi.fn(async () => ({ requestBoundaryFound: true }));
    const storeAfterRestart = new ReplyDeliveryCheckpointStore(database, () => 200);
    const result = await recoverReplyDeliveryCheckpoints({
      store: storeAfterRestart,
      reconcileHistory,
    });

    expect(reconcileHistory).toHaveBeenCalledTimes(1);
    expect(reconcileHistory).toHaveBeenCalledWith(expect.objectContaining({
      confirmedVisibleText: '第一句',
    }));
    expect(result).toEqual({ scanned: 1, reconciled: 1, outcomeUnknown: 1 });
    expect(database.rows.get('request-2')).toMatchObject({
      state: 'outcome_unknown',
      deliveryOutcomeUnknown: true,
      dispatchingIndex: 1,
      reconciledAt: 200,
    });
  });

  it('materializes every confirmed unit after all receipts were checkpointed before the crash', async () => {
    let now = 100;
    const database = createDatabase();
    const storeBeforeCrash = new ReplyDeliveryCheckpointStore(database, () => now++);
    const checkpoint = await storeBeforeCrash.beginRequest('request-3', 'conversation-3');
    await storeBeforeCrash.markRequestBoundaryPersisted(checkpoint);
    const units = plannedUnits();
    await storeBeforeCrash.setPlannedUnits(checkpoint, units);
    await storeBeforeCrash.beginUnit(checkpoint, 0);
    await storeBeforeCrash.confirmUnit(checkpoint, units[0], ['message-1']);
    await storeBeforeCrash.beginUnit(checkpoint, 1);
    await storeBeforeCrash.confirmUnit(checkpoint, units[1], ['message-2']);

    const reconcileHistory = vi.fn(async () => ({ requestBoundaryFound: true }));
    const storeAfterRestart = new ReplyDeliveryCheckpointStore(database, () => 200);
    await recoverReplyDeliveryCheckpoints({ store: storeAfterRestart, reconcileHistory });

    expect(reconcileHistory).toHaveBeenCalledWith(expect.objectContaining({
      confirmedVisibleText: '第一句\n第二句',
    }));
    expect(JSON.parse(checkpoint.confirmedUnitsJson)).toEqual([
      expect.objectContaining({ index: 0, receipt: ['message-1'], historyText: '第一句' }),
      expect.objectContaining({ index: 1, receipt: ['message-2'], historyText: '第二句' }),
    ]);
    expect(database.rows.has('request-3')).toBe(false);
  });

  it('keeps a persisted-boundary checkpoint pending when recovery cannot find its request tail', async () => {
    const database = createDatabase();
    const store = new ReplyDeliveryCheckpointStore(database, () => 100);
    const checkpoint = await store.beginRequest('request-4', 'conversation-4');
    await store.markRequestBoundaryPersisted(checkpoint);

    await expect(recoverReplyDeliveryCheckpoints({
      store,
      reconcileHistory: async () => ({ requestBoundaryFound: false }),
    })).rejects.toThrow('persisted request boundary is missing');
    expect(database.rows.get('request-4')).toMatchObject({
      state: 'reconciliation_failed',
      reconciledAt: null,
    });
  });

  it('does not advance in-memory state when a durable transition write fails', async () => {
    const database = createDatabase();
    const store = new ReplyDeliveryCheckpointStore(database, () => 100);
    const checkpoint = await store.beginRequest('request-5', 'conversation-5');
    const originalSet = database.set.bind(database);
    database.set = vi.fn(async () => {
      throw new Error('disk unavailable');
    });

    await expect(store.markRequestBoundaryPersisted(checkpoint)).rejects.toThrow('disk unavailable');
    expect(checkpoint.requestBoundaryPersisted).toBe(false);
    await expect(store.setPlannedUnits(checkpoint, plannedUnits())).rejects.toThrow('disk unavailable');
    expect(checkpoint).toMatchObject({
      state: 'awaiting_model',
      plannedUnitsJson: '[]',
      dispatchingIndex: null,
    });

    database.set = originalSet;
    await store.markRequestBoundaryPersisted(checkpoint);
    await store.setPlannedUnits(checkpoint, plannedUnits());
    database.set = vi.fn(async () => {
      throw new Error('disk unavailable');
    });
    await expect(store.beginUnit(checkpoint, 0)).rejects.toThrow('disk unavailable');
    expect(checkpoint).toMatchObject({ state: 'prepared', dispatchingIndex: null });
  });

  it('keeps a dispatching unit retryable in memory when receipt persistence fails', async () => {
    const database = createDatabase();
    const store = new ReplyDeliveryCheckpointStore(database, () => 100);
    const checkpoint = await store.beginRequest('request-6', 'conversation-6');
    const units = plannedUnits();
    await store.setPlannedUnits(checkpoint, units);
    await store.beginUnit(checkpoint, 0);
    const originalSet = database.set.bind(database);
    database.set = vi.fn(async () => {
      throw new Error('disk unavailable');
    });

    await expect(store.confirmUnit(checkpoint, units[0], ['message-1'])).rejects.toThrow('disk unavailable');
    expect(checkpoint).toMatchObject({
      state: 'dispatching',
      dispatchingIndex: 0,
      confirmedUnitsJson: '[]',
    });

    database.set = originalSet;
    await store.confirmUnit(checkpoint, units[0], ['message-1']);
    expect(store.getConfirmedHistoryText(checkpoint)).toBe('第一句');
  });

  it('does not report reconciliation complete when checkpoint deletion fails', async () => {
    const database = createDatabase();
    const store = new ReplyDeliveryCheckpointStore(database, () => 100);
    const checkpoint = await store.beginRequest('request-7', 'conversation-7');
    database.remove = vi.fn(async () => {
      throw new Error('disk unavailable');
    });

    await expect(store.markReconciled(checkpoint)).rejects.toThrow('disk unavailable');
    expect(checkpoint).toMatchObject({
      state: 'awaiting_model',
      reconciledAt: null,
    });
    expect(database.rows.has('request-7')).toBe(true);
  });

  it('rejects a receipt for a payload that differs from the durable dispatch plan', async () => {
    const database = createDatabase();
    const store = new ReplyDeliveryCheckpointStore(database, () => 100);
    const checkpoint = await store.beginRequest('request-8', 'conversation-8');
    const units = plannedUnits();
    await store.setPlannedUnits(checkpoint, units);
    await store.beginUnit(checkpoint, 0);

    await expect(store.confirmUnit(checkpoint, {
      ...units[0],
      historyText: '篡改后的文本',
      payload: { content: '篡改后的文本' },
    }, ['message-1'])).rejects.toThrow('does not match the prepared payload');
    expect(checkpoint.confirmedUnitsJson).toBe('[]');
  });

  it('bounds retained outcome-unknown diagnostics by age and count', async () => {
    let now = 100;
    const database = createDatabase();
    const store = new ReplyDeliveryCheckpointStore(database, () => now);
    for (const requestId of ['unknown-1', 'unknown-2', 'unknown-3']) {
      const checkpoint = await store.beginRequest(requestId, `conversation-${requestId}`);
      await store.setPlannedUnits(checkpoint, plannedUnits());
      await store.beginUnit(checkpoint, 0);
      await store.markOutcomeUnknown(checkpoint, new Error('connection closed'));
      await store.markReconciled(checkpoint);
      now += 10;
    }

    now = 1_000;
    await expect(store.pruneReconciledDiagnostics({ maxAgeMs: 885, maxRecords: 2 })).resolves.toBe(2);
    expect([...database.rows.keys()]).toEqual(['unknown-3']);
  });

  it('finishes a dropped request after restart when history committed before checkpoint cleanup', async () => {
    const database = createDatabase();
    const store = new ReplyDeliveryCheckpointStore(database, () => 100);
    const checkpoint = await store.beginRequest('request-drop', 'conversation-drop');
    await store.markRequestBoundaryPersisted(checkpoint);
    await store.beginReconciliation(checkpoint, 'drop_request', '');

    const reconcileHistory = vi.fn(async (input) => {
      expect(input.requestDisposition).toBe('drop_request');
      // The prior process committed the drop transaction, so the human boundary
      // is intentionally absent when checkpoint cleanup retries after restart.
      return { requestBoundaryFound: false };
    });
    await expect(recoverReplyDeliveryCheckpoints({ store, reconcileHistory })).resolves.toEqual({
      scanned: 1,
      reconciled: 1,
      outcomeUnknown: 0,
    });
    expect(database.rows.has('request-drop')).toBe(false);
  });
});
