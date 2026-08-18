/**
 * Aggregate `RunStats.goldEconomy` across a sweep so the Floor 1 economy gate
 * is readable from a sweep artifact, not just from the headless CLI's per-run
 * output.
 *
 * The gate this feeds is defined in `tests/headless/floor1-economy-gate.test.ts`:
 * median unspent share of **spendable** income, at a minimum win rate. Only
 * winning runs are summarized — a run that died on Floor 1 never reached the
 * shops, so including it would report the loss as an economy problem.
 */
import type { RunStats } from '../../../src/game/ai/types.js';

export interface GoldEconomySummary {
  /** Winning runs that reported gold-economy telemetry. */
  readonly runs: number;
  readonly medianEarnedTotal: number;
  /** Income earned before the floor-exit latch, i.e. gold a run could spend. */
  readonly medianSpendableEarned: number;
  readonly medianSpentTotal: number;
  /** Median unspent share of spendable income — the gated quantity. */
  readonly medianUnspentSpendableFraction: number;
  /** Median unspent share of *all* income, including post-exit grants. */
  readonly medianUnspentFraction: number;
  /** Share of runs buying each vendor's offer. */
  readonly charmPurchaseRate: number;
  readonly weaponPurchaseRate: number;
  readonly spellPurchaseRate: number;
  /** Median count of distinct vendors bought from in a run. */
  readonly medianDistinctPurchases: number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeGoldEconomy(runs: readonly RunStats[]): GoldEconomySummary | null {
  const economies = runs
    .filter((run) => run.outcome === 'victory')
    .map((run) => run.goldEconomy)
    .filter((economy): economy is NonNullable<RunStats['goldEconomy']> => economy !== undefined);
  if (economies.length === 0) {
    return null;
  }
  const rate = (predicate: (economy: (typeof economies)[number]) => boolean): number =>
    economies.filter(predicate).length / economies.length;
  return {
    runs: economies.length,
    medianEarnedTotal: median(economies.map((economy) => economy.earnedTotal)),
    medianSpendableEarned: median(economies.map((economy) => economy.spendableEarned)),
    medianSpentTotal: median(economies.map((economy) => economy.spentTotal)),
    medianUnspentSpendableFraction: median(
      economies.map((economy) => economy.unspentSpendableFraction),
    ),
    medianUnspentFraction: median(economies.map((economy) => economy.unspentFraction)),
    charmPurchaseRate: rate((economy) => economy.charmPurchases > 0),
    weaponPurchaseRate: rate((economy) => economy.merchantWeaponPurchases > 0),
    spellPurchaseRate: rate((economy) => economy.spellPurchases > 0),
    medianDistinctPurchases: median(economies.map((economy) => economy.distinctPurchases)),
  };
}

export function formatGoldEconomySummary(summary: GoldEconomySummary | null): string[] {
  if (!summary) {
    return ['Gold economy: no winning runs reported telemetry'];
  }
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    `Gold economy (median of ${summary.runs} winning runs)`,
    `  Earned:            ${summary.medianEarnedTotal} (spendable ${summary.medianSpendableEarned})`,
    `  Spent:             ${summary.medianSpentTotal}`,
    `  Unspent/spendable: ${pct(summary.medianUnspentSpendableFraction)}  (of all income ${pct(summary.medianUnspentFraction)})`,
    `  Bought charm/weapon/spell: ${pct(summary.charmPurchaseRate)} / ${pct(summary.weaponPurchaseRate)} / ${pct(summary.spellPurchaseRate)}`,
    `  Distinct vendors:  ${summary.medianDistinctPurchases}`,
  ];
}
