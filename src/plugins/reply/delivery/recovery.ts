import {
  ReplyDeliveryCheckpointStore,
  type ReplyDeliveryCheckpointRecord,
} from './checkpoint-store.js';

export interface ReplyDeliveryHistoryReconciliationResult {
  requestBoundaryFound: boolean;
}

export interface ReplyDeliveryRecoveryResult {
  scanned: number;
  reconciled: number;
  outcomeUnknown: number;
}

export type ReplyDeliveryHistoryReconciler = (input: {
  conversationId: string;
  requestId: string;
  confirmedVisibleText: string;
  requestDisposition: 'retain_request' | 'drop_request';
  allowMissingBoundary: boolean;
}) => Promise<ReplyDeliveryHistoryReconciliationResult>;

function isDispatchOutcomeUnknown(record: ReplyDeliveryCheckpointRecord): boolean {
  return record.state === 'dispatching' || record.deliveryOutcomeUnknown;
}

export async function recoverReplyDeliveryCheckpoints(args: {
  store: ReplyDeliveryCheckpointStore;
  reconcileHistory: ReplyDeliveryHistoryReconciler;
  conversationId?: string;
  diagnosticRetention?: { maxAgeMs: number; maxRecords: number };
}): Promise<ReplyDeliveryRecoveryResult> {
  const records = await args.store.listUnreconciled(args.conversationId);
  let reconciled = 0;
  let outcomeUnknown = 0;

  for (const record of records) {
    const dispatchOutcomeUnknown = isDispatchOutcomeUnknown(record);
    if (record.state === 'dispatching') {
      await args.store.markOutcomeUnknown(
        record,
        new Error(`process stopped while dispatching unit ${String(record.dispatchingIndex)}`),
      );
    }

    try {
      const requestDisposition = record.reconciliationDisposition ?? 'retain_request';
      const confirmedVisibleText = record.reconciliationVisibleText
        ?? args.store.getConfirmedHistoryText(record);
      const result = await args.reconcileHistory({
        conversationId: record.conversationId,
        requestId: record.requestId,
        confirmedVisibleText,
        requestDisposition,
        allowMissingBoundary: !record.requestBoundaryPersisted,
      });
      const dropAlreadyApplied = (
        !result.requestBoundaryFound
        && record.reconciliationDisposition === 'drop_request'
      );
      if (!result.requestBoundaryFound && record.requestBoundaryPersisted && !dropAlreadyApplied) {
        throw new Error(`persisted request boundary is missing for ${record.requestId}.`);
      }
      await args.store.markReconciled(record);
      reconciled += 1;
      if (dispatchOutcomeUnknown) outcomeUnknown += 1;
    } catch (error) {
      await args.store.markReconciliationFailed(record, error);
      throw error;
    }
  }

  await args.store.pruneReconciledDiagnostics(args.diagnosticRetention ?? {
    maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    maxRecords: 256,
  });

  return {
    scanned: records.length,
    reconciled,
    outcomeUnknown,
  };
}
