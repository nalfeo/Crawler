export type SettlementMaintenanceDecisionKind =
  | 'claim-achievement'
  | 'open-boss-chest'
  | 'acknowledge-boss-chest'
  | 'purchase-equipment'
  | 'equip-instance'
  | 'configure-ability'
  | 'skip';

export interface SettlementMaintenanceDecision {
  readonly kind: SettlementMaintenanceDecisionKind;
  readonly detail: string;
  /** Present for scored equipment decisions — the evaluator's swap score. */
  readonly utility?: number;
  /** Present for purchase decisions — gold spent. */
  readonly cost?: number;
}

export type SettlementMaintenanceTerminationReason =
  | 'no-opportunity'
  | 'already-processed'
  | 'action-cap-equipment'
  | 'exhausted';

export interface SettlementMaintenanceResult {
  /** True only when the planner actually ran its decision loops this call. */
  readonly ran: boolean;
  readonly terminationReason: SettlementMaintenanceTerminationReason;
  readonly decisions: readonly SettlementMaintenanceDecision[];
}
