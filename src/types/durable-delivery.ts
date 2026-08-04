export type DurableDeliveryState =
  | 'not_started'
  | 'dispatching'
  | 'confirmed'
  | 'reconciled'
  | 'outcome_unknown'
  | 'reconciliation_failed';
