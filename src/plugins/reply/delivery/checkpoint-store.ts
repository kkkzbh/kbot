import type {} from 'koishi';

export const REPLY_DELIVERY_CHECKPOINT_TABLE = 'reply_delivery_checkpoint' as const;

export type ReplyDeliveryCheckpointState =
  | 'awaiting_model'
  | 'prepared'
  | 'dispatching'
  | 'confirmed_partial'
  | 'confirmed_complete'
  | 'reconciled'
  | 'outcome_unknown'
  | 'reconciliation_failed';

export type ReplyDeliveryRequestDisposition = 'retain_request' | 'drop_request';

export interface ReplyDeliveryPlannedUnit {
  index: number;
  kind: string;
  payload: Record<string, unknown>;
  historyText: string;
  persistToHistory: boolean;
}

export interface ReplyDeliveryConfirmedUnit extends ReplyDeliveryPlannedUnit {
  receipt: string[];
  confirmedAt: number;
}

export interface ReplyDeliveryCheckpointRecord {
  requestId: string;
  conversationId: string;
  state: ReplyDeliveryCheckpointState;
  plannedUnitsJson: string;
  confirmedUnitsJson: string;
  dispatchingIndex: number | null;
  deliveryOutcomeUnknown: boolean;
  requestBoundaryPersisted: boolean;
  reconciliationDisposition: ReplyDeliveryRequestDisposition | null;
  reconciliationVisibleText: string | null;
  reconciledAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReplyDeliveryCheckpointDatabase {
  get(
    table: typeof REPLY_DELIVERY_CHECKPOINT_TABLE,
    query: Record<string, unknown>,
  ): Promise<ReplyDeliveryCheckpointRecord[]>;
  upsert(
    table: typeof REPLY_DELIVERY_CHECKPOINT_TABLE,
    rows: ReplyDeliveryCheckpointRecord[],
    keys?: ['requestId'],
  ): Promise<unknown>;
  set(
    table: typeof REPLY_DELIVERY_CHECKPOINT_TABLE,
    query: { requestId: string },
    update: Partial<ReplyDeliveryCheckpointRecord>,
  ): Promise<unknown>;
  remove(
    table: typeof REPLY_DELIVERY_CHECKPOINT_TABLE,
    query: { requestId: string },
  ): Promise<unknown>;
}

export interface ReplyDeliveryCheckpointModel {
  extend(
    table: typeof REPLY_DELIVERY_CHECKPOINT_TABLE,
    fields: Record<string, unknown>,
    config: Record<string, unknown>,
  ): unknown;
}

declare module 'koishi' {
  interface Tables {
    reply_delivery_checkpoint: ReplyDeliveryCheckpointRecord;
  }
}

function requireIdentity(value: string, label: 'requestId' | 'conversationId'): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`reply delivery checkpoint requires ${label}.`);
  return normalized;
}

function parseJsonArray<T>(raw: string, label: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`reply delivery checkpoint has invalid ${label} JSON.`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`reply delivery checkpoint ${label} must be an array.`);
  }
  return parsed as T[];
}

function normalizeReceipt(receipt: readonly string[]): string[] {
  if (receipt.length === 0) {
    throw new Error('reply delivery checkpoint confirmation requires a receipt.');
  }
  return receipt.map((messageId) => {
    const normalized = messageId.trim();
    if (!normalized) {
      throw new Error('reply delivery checkpoint receipt contains an empty message id.');
    }
    return normalized;
  });
}

function normalizeUnit(unit: ReplyDeliveryPlannedUnit, index: number): ReplyDeliveryPlannedUnit {
    if (unit.index !== index) {
      throw new Error(`reply delivery checkpoint unit index must be contiguous at ${index}.`);
    }
    const kind = unit.kind.trim();
    if (!kind) throw new Error(`reply delivery checkpoint unit ${index} requires kind.`);
    const historyText = unit.historyText.trim();
    if (!historyText) {
      throw new Error(`reply delivery checkpoint unit ${index} requires historyText.`);
    }
    if (typeof unit.persistToHistory !== 'boolean') {
      throw new Error(`reply delivery checkpoint unit ${index} requires persistToHistory.`);
    }
    return {
      index,
      kind,
      payload: { ...unit.payload },
      historyText,
      persistToHistory: unit.persistToHistory,
    };
}

function validatePlannedUnits(units: readonly ReplyDeliveryPlannedUnit[]): ReplyDeliveryPlannedUnit[] {
  return units.map(normalizeUnit);
}

function validateRecord(record: ReplyDeliveryCheckpointRecord): ReplyDeliveryCheckpointRecord {
  requireIdentity(record.requestId, 'requestId');
  requireIdentity(record.conversationId, 'conversationId');
  parseJsonArray(record.plannedUnitsJson, 'plannedUnits');
  parseJsonArray(record.confirmedUnitsJson, 'confirmedUnits');
  if (
    record.reconciliationDisposition != null
    && record.reconciliationDisposition !== 'retain_request'
    && record.reconciliationDisposition !== 'drop_request'
  ) {
    throw new Error('reply delivery checkpoint has an invalid reconciliation disposition.');
  }
  return record;
}

export function registerReplyDeliveryCheckpointTable(model: ReplyDeliveryCheckpointModel): void {
  model.extend(
    REPLY_DELIVERY_CHECKPOINT_TABLE,
    {
      requestId: 'string',
      conversationId: 'string',
      state: 'string',
      plannedUnitsJson: 'text',
      confirmedUnitsJson: 'text',
      dispatchingIndex: { type: 'integer', nullable: true },
      deliveryOutcomeUnknown: 'boolean',
      requestBoundaryPersisted: 'boolean',
      reconciliationDisposition: { type: 'string', nullable: true },
      reconciliationVisibleText: { type: 'text', nullable: true },
      reconciledAt: { type: 'double', nullable: true },
      lastError: { type: 'text', nullable: true },
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: false,
      primary: 'requestId',
    },
  );
}

export class ReplyDeliveryCheckpointStore {
  constructor(
    private readonly database: ReplyDeliveryCheckpointDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async beginRequest(requestIdInput: string, conversationIdInput: string): Promise<ReplyDeliveryCheckpointRecord> {
    const requestId = requireIdentity(requestIdInput, 'requestId');
    const conversationId = requireIdentity(conversationIdInput, 'conversationId');
    const existing = await this.load(requestId);
    if (existing) {
      throw new Error(`reply delivery checkpoint already exists for ${requestId}.`);
    }
    const now = this.now();
    const record: ReplyDeliveryCheckpointRecord = {
      requestId,
      conversationId,
      state: 'awaiting_model',
      plannedUnitsJson: '[]',
      confirmedUnitsJson: '[]',
      dispatchingIndex: null,
      deliveryOutcomeUnknown: false,
      requestBoundaryPersisted: false,
      reconciliationDisposition: null,
      reconciliationVisibleText: null,
      reconciledAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.database.upsert(REPLY_DELIVERY_CHECKPOINT_TABLE, [record], ['requestId']);
    return record;
  }

  async markRequestBoundaryPersisted(record: ReplyDeliveryCheckpointRecord): Promise<void> {
    if (record.requestBoundaryPersisted) return;
    await this.persist(record, { requestBoundaryPersisted: true });
  }

  async beginReconciliation(
    record: ReplyDeliveryCheckpointRecord,
    disposition: ReplyDeliveryRequestDisposition,
    visibleTextInput: string,
  ): Promise<void> {
    const visibleText = visibleTextInput.trim();
    if (disposition === 'drop_request' && visibleText) {
      throw new Error('reply delivery checkpoint cannot attach visible text to a dropped request.');
    }
    if (
      record.reconciliationDisposition != null
      && (
        record.reconciliationDisposition !== disposition
        || record.reconciliationVisibleText !== visibleText
      )
    ) {
      throw new Error('reply delivery checkpoint reconciliation intent cannot change.');
    }
    if (record.reconciliationDisposition === disposition) return;
    await this.persist(record, {
      reconciliationDisposition: disposition,
      reconciliationVisibleText: visibleText,
    });
  }

  async setPlannedUnits(
    record: ReplyDeliveryCheckpointRecord,
    unitsInput: readonly ReplyDeliveryPlannedUnit[],
  ): Promise<void> {
    if (record.state !== 'awaiting_model' && record.state !== 'prepared') {
      throw new Error(`reply delivery checkpoint cannot prepare units from state ${record.state}.`);
    }
    const units = validatePlannedUnits(unitsInput);
    if (units.length === 0) {
      throw new Error('reply delivery checkpoint requires at least one planned unit.');
    }
    const plannedUnitsJson = JSON.stringify(units);
    await this.persist(record, {
      plannedUnitsJson,
      state: 'prepared',
      dispatchingIndex: null,
      lastError: null,
    });
  }

  async appendPlannedUnits(
    record: ReplyDeliveryCheckpointRecord,
    unitsInput: readonly ReplyDeliveryPlannedUnit[],
  ): Promise<ReplyDeliveryPlannedUnit[]> {
    if (record.state !== 'awaiting_model' && record.state !== 'confirmed_complete') {
      throw new Error(`reply delivery checkpoint cannot append units from state ${record.state}.`);
    }
    const planned = this.getPlannedUnits(record);
    const confirmed = this.getConfirmedUnits(record);
    if (planned.length !== confirmed.length) {
      throw new Error('reply delivery checkpoint cannot append while prior units are unconfirmed.');
    }
    const appended = unitsInput.map((unit, offset) => normalizeUnit({
      ...unit,
      index: planned.length + offset,
    }, planned.length + offset));
    if (appended.length === 0) {
      throw new Error('reply delivery checkpoint requires at least one appended unit.');
    }
    await this.persist(record, {
      plannedUnitsJson: JSON.stringify([...planned, ...appended]),
      state: 'prepared',
      dispatchingIndex: null,
      lastError: null,
    });
    return appended;
  }

  async beginUnit(record: ReplyDeliveryCheckpointRecord, unitIndex: number): Promise<void> {
    const planned = this.getPlannedUnits(record);
    const confirmed = this.getConfirmedUnits(record);
    if (record.state !== 'prepared' && record.state !== 'confirmed_partial') {
      throw new Error(`reply delivery checkpoint cannot dispatch from state ${record.state}.`);
    }
    if (unitIndex !== confirmed.length || planned[unitIndex]?.index !== unitIndex) {
      throw new Error(`reply delivery checkpoint cannot dispatch unit ${unitIndex}.`);
    }
    await this.persist(record, {
      state: 'dispatching',
      dispatchingIndex: unitIndex,
      lastError: null,
    });
  }

  async replaceDispatchingUnit(
    record: ReplyDeliveryCheckpointRecord,
    unitInput: ReplyDeliveryPlannedUnit,
  ): Promise<void> {
    if (record.state !== 'dispatching' || record.dispatchingIndex == null) {
      throw new Error('reply delivery checkpoint has no dispatching unit to replace.');
    }
    const planned = this.getPlannedUnits(record);
    const unit = normalizeUnit(unitInput, record.dispatchingIndex);
    planned[record.dispatchingIndex] = unit;
    await this.persist(record, {
      plannedUnitsJson: JSON.stringify(planned),
    });
  }

  async cancelDispatchingUnit(record: ReplyDeliveryCheckpointRecord, error: unknown): Promise<void> {
    if (record.state !== 'dispatching') return;
    const confirmed = this.getConfirmedUnits(record);
    await this.persist(record, {
      state: confirmed.length > 0 ? 'confirmed_partial' : 'prepared',
      dispatchingIndex: null,
      lastError: error instanceof Error ? error.message : String(error),
    });
  }

  async confirmUnit(
    record: ReplyDeliveryCheckpointRecord,
    unit: ReplyDeliveryPlannedUnit,
    receiptInput: readonly string[],
  ): Promise<void> {
    if (record.state !== 'dispatching' || record.dispatchingIndex !== unit.index) {
      throw new Error(`reply delivery checkpoint cannot confirm unit ${unit.index}.`);
    }
    const planned = this.getPlannedUnits(record);
    const confirmed = this.getConfirmedUnits(record);
    const expected = planned[unit.index];
    if (!expected) throw new Error(`reply delivery checkpoint unit ${unit.index} was not prepared.`);
    if (confirmed.length !== unit.index) {
      throw new Error(`reply delivery checkpoint unit ${unit.index} confirmation is out of order.`);
    }
    const confirmedUnit = normalizeUnit(unit, expected.index);
    if (JSON.stringify(expected) !== JSON.stringify(confirmedUnit)) {
      throw new Error(`reply delivery checkpoint unit ${unit.index} does not match the prepared payload.`);
    }
    confirmed.push({
      ...confirmedUnit,
      receipt: normalizeReceipt(receiptInput),
      confirmedAt: this.now(),
    });
    const confirmedUnitsJson = JSON.stringify(confirmed);
    const state = confirmed.length === planned.length ? 'confirmed_complete' : 'confirmed_partial';
    await this.persist(record, {
      confirmedUnitsJson,
      dispatchingIndex: null,
      state,
      lastError: null,
    });
  }

  async markOutcomeUnknown(record: ReplyDeliveryCheckpointRecord, error: unknown): Promise<void> {
    if (record.state !== 'dispatching') return;
    const lastError = error instanceof Error ? error.message : String(error);
    await this.persist(record, {
      state: 'outcome_unknown',
      deliveryOutcomeUnknown: true,
      lastError,
    });
  }

  async markReconciled(record: ReplyDeliveryCheckpointRecord): Promise<void> {
    const reconciledAt = this.now();
    if (record.deliveryOutcomeUnknown) {
      await this.persist(record, {
        state: 'outcome_unknown',
        reconciledAt,
      });
      return;
    }
    await this.database.remove(
      REPLY_DELIVERY_CHECKPOINT_TABLE,
      { requestId: record.requestId },
    );
    Object.assign(record, {
      state: 'reconciled',
      reconciledAt,
      dispatchingIndex: null,
      lastError: null,
      updatedAt: reconciledAt,
    } satisfies Partial<ReplyDeliveryCheckpointRecord>);
  }

  async markReconciliationFailed(record: ReplyDeliveryCheckpointRecord, error: unknown): Promise<void> {
    const lastError = error instanceof Error ? error.message : String(error);
    await this.persist(record, {
      state: 'reconciliation_failed',
      lastError,
    });
  }

  async load(requestIdInput: string): Promise<ReplyDeliveryCheckpointRecord | null> {
    const requestId = requireIdentity(requestIdInput, 'requestId');
    const rows = await this.database.get(REPLY_DELIVERY_CHECKPOINT_TABLE, { requestId });
    if (rows.length > 1) {
      throw new Error(`reply delivery checkpoint primary key returned multiple rows for ${requestId}.`);
    }
    return rows[0] ? validateRecord(rows[0]) : null;
  }

  async listUnreconciled(conversationIdInput?: string): Promise<ReplyDeliveryCheckpointRecord[]> {
    const conversationId = conversationIdInput == null
      ? null
      : requireIdentity(conversationIdInput, 'conversationId');
    const rows = await this.database.get(
      REPLY_DELIVERY_CHECKPOINT_TABLE,
      conversationId == null ? {} : { conversationId },
    );
    return rows
      .map(validateRecord)
      .filter((record) => record.reconciledAt == null)
      .sort((left, right) => left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId));
  }

  async pruneReconciledDiagnostics(options: {
    maxAgeMs: number;
    maxRecords: number;
  }): Promise<number> {
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
      throw new Error('reply delivery checkpoint diagnostic maxAgeMs must be non-negative.');
    }
    if (!Number.isInteger(options.maxRecords) || options.maxRecords < 0) {
      throw new Error('reply delivery checkpoint diagnostic maxRecords must be a non-negative integer.');
    }
    const now = this.now();
    const diagnostics = (await this.database.get(REPLY_DELIVERY_CHECKPOINT_TABLE, {}))
      .map(validateRecord)
      .filter((record) => record.reconciledAt != null)
      .sort((left, right) => (right.reconciledAt ?? 0) - (left.reconciledAt ?? 0));
    const expired = diagnostics.filter((record, index) => (
      now - (record.reconciledAt ?? 0) > options.maxAgeMs || index >= options.maxRecords
    ));
    for (const record of expired) {
      await this.database.remove(REPLY_DELIVERY_CHECKPOINT_TABLE, { requestId: record.requestId });
    }
    return expired.length;
  }

  getPlannedUnits(record: ReplyDeliveryCheckpointRecord): ReplyDeliveryPlannedUnit[] {
    return validatePlannedUnits(parseJsonArray<ReplyDeliveryPlannedUnit>(record.plannedUnitsJson, 'plannedUnits'));
  }

  getConfirmedUnits(record: ReplyDeliveryCheckpointRecord): ReplyDeliveryConfirmedUnit[] {
    const units = parseJsonArray<ReplyDeliveryConfirmedUnit>(record.confirmedUnitsJson, 'confirmedUnits');
    return units.map((unit, index) => {
      if (unit.index !== index) {
        throw new Error(`reply delivery checkpoint confirmed unit index must be contiguous at ${index}.`);
      }
      return {
        ...unit,
        receipt: normalizeReceipt(unit.receipt),
      };
    });
  }

  getConfirmedHistoryText(record: ReplyDeliveryCheckpointRecord): string {
    return this.getConfirmedUnits(record)
      .filter((unit) => unit.persistToHistory)
      .map((unit) => unit.historyText.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  private async persist(
    record: ReplyDeliveryCheckpointRecord,
    update: Partial<ReplyDeliveryCheckpointRecord>,
  ): Promise<void> {
    const updatedAt = this.now();
    const committedUpdate = { ...update, updatedAt };
    await this.database.set(
      REPLY_DELIVERY_CHECKPOINT_TABLE,
      { requestId: record.requestId },
      committedUpdate,
    );
    Object.assign(record, committedUpdate);
  }
}
