/**
 * Official headless **Floor 1 economy gate**.
 *
 * The completion gate (`floor1-completion.test.ts`) answers "can the AI still
 * clear Floor 1?". This one answers the economy question next to it: **does a
 * completed Floor 1 run actually convert its income into power, or does it bank
 * a fortune and walk downstairs rich?**
 *
 * Before this gate existed, a run ended Floor 1 holding ~800 unspent gold
 * against a total purchasable board of ~110 gold (charm 15, one starter weapon
 * 18-30, one spell 35). Floor 1 had no meaningful sink, so ~90% of its income
 * flowed into Floor 2 untouched.
 *
 * ## What is gated
 *
 * - **Win rate** over the same contiguous seed prefix the completion gate uses
 *   (`GATE_SEEDS`), so pricing can never be "fixed" by making the floor
 *   unwinnable, and the sample cannot be gamed by hand-picking comfortable
 *   seeds (AGENTS.md r12).
 * - **Median unspent share of spendable income** ≤ {@link MAX_MEDIAN_UNSPENT_SPENDABLE_FRACTION}.
 * - Two behavioral tiebreakers that would otherwise silently rot: a spell is
 *   bought in the large majority of winning runs, and the median winning run
 *   makes purchases at two or more distinct vendors.
 *
 * ## Why "spendable" income, not total income
 *
 * Floor 1 grants a fixed block of gold through **floor-clear achievement loot
 * boxes that resolve after the exit is confirmed** — measured at exactly 125
 * gold per winning run on this panel. That gold lands when no vendor is
 * reachable any more, so it is Floor 2 seed money by construction and can never
 * appear as Floor 1 spend at any price. Gating on total earned would therefore
 * gate partly on an unreachable quantity.
 *
 * `RunStats.goldEconomy` reports **both**: `unspentFraction` (of everything
 * earned) and `unspentSpendableFraction` (of income earned before the exit
 * latch, see `markGoldLedgerFloorExit`). The assertion uses the latter because
 * it is the share the run could actually have spent; the former is still
 * printed by the CLI so the carryover into Floor 2 stays visible.
 *
 * ## Median, not mean
 *
 * A single seed that runs out of gold moments before the weapon it wanted
 * (Floor 1 income is lumpy — loot boxes arrive in blocks) should not move the
 * gate. The median is the "well-played run" the pricing targets.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FLOOR1_TIME_BUDGET_MS,
  GATE_MAX_FRAMES,
  GATE_SEEDS,
  GATE_WALL_TIME_CAP_MS,
} from '../../scripts/agent/perf/floor1-gate-sample.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import type { RunStats } from '../../src/game/ai/types.js';

/**
 * Minimum win-rate over the panel. The repricing was bounded to "≥90% Floor 1
 * win rate" (see the repricing handoff), so this floor is 0.9 rather than the
 * completion gate's looser 0.88 — a 25-seed panel means 0.88 would tolerate
 * 22/25 (88%), one seed below the agreed bound. Measured on this branch:
 * 25/25 = 100%.
 */
const MIN_WIN_RATE = 0.9;

/**
 * Ceiling on the median winning run's unspent share of **spendable** income.
 *
 * The design target (option (b)): a run buys one or two of the things on offer
 * and still banks a stake for Floor 2 — not a full spend-down (a), and not the
 * pre-existing hoard (c).
 *
 * Measured on this branch over `GATE_SEEDS`: **34.0%**. The margin to the 35%
 * ceiling is deliberately thin because Floor 1's purchasable board, priced at
 * the top of its bands, is close to a run's spendable income by design — that
 * closeness is what makes the purchase a choice. If a future content change
 * pushes this over, the fix is a **new sink** (the standing proposal is a second
 * broker spell at an escalating price) or lower prices, not a looser ceiling.
 */
const MAX_MEDIAN_UNSPENT_SPENDABLE_FRACTION = 0.35;

/** Share of winning runs that must buy a spell. Measured: 25/25 = 100%. */
const MIN_SPELL_PURCHASE_RATE = 0.8;

/** Median winning run must buy from at least this many distinct vendors. Measured: 2. */
const MIN_MEDIAN_DISTINCT_PURCHASES = 2;

const HOOK_TIMEOUT_MS = GATE_SEEDS.length * 180_000;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function runSeed(seed: number): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed });
  return runHeadless(ai, {
    seed,
    maxFrames: GATE_MAX_FRAMES,
    maxWallTimeMs: GATE_WALL_TIME_CAP_MS,
  });
}

describe('Floor 1 headless economy gate', () => {
  const runs = new Map<number, RunStats>();

  beforeAll(async () => {
    for (const seed of GATE_SEEDS) {
      runs.set(seed, await runSeed(seed));
    }
  }, HOOK_TIMEOUT_MS);

  const winningRuns = (): RunStats[] =>
    GATE_SEEDS.map((seed) => runs.get(seed)!).filter((stats) =>
      isOfficialWin(stats, FLOOR1_TIME_BUDGET_MS),
    );

  it(`still wins at least ${Math.round(MIN_WIN_RATE * 100)}% of the sample`, () => {
    // Pricing must never be "balanced" by making the floor harder to finish.
    const wins = winningRuns().length;
    const rate = wins / GATE_SEEDS.length;
    expect(
      rate,
      `win-rate ${(rate * 100).toFixed(0)}% (${wins}/${GATE_SEEDS.length})`,
    ).toBeGreaterThanOrEqual(MIN_WIN_RATE);
  });

  it('reports complete, self-consistent gold economy accounting', () => {
    for (const stats of winningRuns()) {
      const economy = stats.goldEconomy;
      expect(economy, 'winning run reported no goldEconomy').toBeDefined();
      if (!economy) continue;
      expect(economy.earnedTotal).toBe(economy.earnedFromDrops + economy.earnedFromLootBoxes);
      expect(economy.spentTotal).toBe(
        economy.spentOnCharm + economy.spentOnMerchantWeapon + economy.spentOnSpell,
      );
      // A completed floor always latches its spendable income, and income
      // granted after the exit can only ever add to the total.
      expect(economy.spendableEarned).toBeLessThanOrEqual(economy.earnedTotal);
      expect(economy.spentTotal).toBeLessThanOrEqual(economy.spendableEarned);
      expect(economy.earnedTotal).toBeGreaterThan(0);
    }
  });

  it(`leaves at most ${MAX_MEDIAN_UNSPENT_SPENDABLE_FRACTION * 100}% of spendable gold unspent (median)`, () => {
    const fractions = winningRuns().map(
      (stats) => stats.goldEconomy?.unspentSpendableFraction ?? 1,
    );
    const value = median(fractions);
    expect(
      value,
      `median unspent ${(value * 100).toFixed(1)}% of spendable income over ${fractions.length} winning runs ` +
        `— Floor 1 is banking income instead of selling power. Add a sink or lower prices; do not raise this ceiling.`,
    ).toBeLessThanOrEqual(MAX_MEDIAN_UNSPENT_SPENDABLE_FRACTION);
  });

  it('buys a spell in the large majority of winning runs', () => {
    const wins = winningRuns();
    const withSpell = wins.filter((stats) => (stats.goldEconomy?.spellPurchases ?? 0) > 0).length;
    const rate = wins.length > 0 ? withSpell / wins.length : 0;
    expect(
      rate,
      `only ${withSpell}/${wins.length} winning runs bought a spell`,
    ).toBeGreaterThanOrEqual(MIN_SPELL_PURCHASE_RATE);
  });

  it('makes purchases at two or more distinct vendors in the median run', () => {
    const counts = winningRuns().map((stats) => stats.goldEconomy?.distinctPurchases ?? 0);
    const value = median(counts);
    expect(
      value,
      `median winning run bought from ${value} vendor(s) — Floor 1 shopping is no longer a choice`,
    ).toBeGreaterThanOrEqual(MIN_MEDIAN_DISTINCT_PURCHASES);
  });
});
