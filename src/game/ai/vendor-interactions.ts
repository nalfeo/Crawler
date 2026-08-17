import type { GameWorld } from '../../core/world.js';
import type { VendorDecisionOutcome, VendorInteractionSummary } from './types.js';

const OUTCOME_KINDS: readonly VendorDecisionOutcome[] = [
  'wanted',
  'purchased',
  'unaffordable',
  'declined',
  'abandoned',
];

/**
 * Project the world's vendor ledger into the run-stats summary shape.
 *
 * Pure read: it copies the retained visit/decision records and rolls up the
 * counts, so the same projection serves the headless runner and human runs.
 * `visitCount`/`decisionCount` include records dropped past the ledger's
 * retention cap, so a truncated tail is still visible as a count.
 */
export function computeVendorInteractions(world: GameWorld): VendorInteractionSummary {
  const ledger = world.vendorLedger;
  const visitsByVendor: Record<string, number> = {};
  for (const visit of ledger.visits) {
    visitsByVendor[visit.vendorId] = (visitsByVendor[visit.vendorId] ?? 0) + 1;
  }
  const outcomeCounts = Object.fromEntries(OUTCOME_KINDS.map((kind) => [kind, 0])) as Record<
    VendorDecisionOutcome,
    number
  >;
  for (const decision of ledger.decisions) {
    outcomeCounts[decision.outcome] += 1;
  }
  return {
    visits: ledger.visits.map((visit) => ({
      vendorId: visit.vendorId,
      gameTimeMs: visit.gameTimeMs,
      playerGold: visit.playerGold,
      stock: visit.stock.map((entry) => ({ itemId: entry.itemId, cost: entry.cost })),
    })),
    decisions: ledger.decisions.map((decision) => ({
      vendorId: decision.vendorId,
      itemId: decision.itemId,
      cost: decision.cost,
      outcome: decision.outcome,
      playerGold: decision.playerGold,
      gameTimeMs: decision.gameTimeMs,
      reason: decision.reason,
    })),
    visitCount: ledger.visits.length + ledger.droppedVisits,
    decisionCount: ledger.decisions.length + ledger.droppedDecisions,
    visitsByVendor,
    outcomeCounts,
  };
}
