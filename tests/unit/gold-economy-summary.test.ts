/**
 * Unit tests for the sweep-side gold-economy aggregator that makes the Floor 1
 * economy gate readable from a sweep artifact.
 */
import { describe, expect, it } from 'vitest';
import type { RunStats } from '../../src/game/ai/types.js';
import {
  formatGoldEconomySummary,
  median,
  summarizeGoldEconomy,
} from '../../scripts/agent/perf/gold-economy-summary.js';

function run(
  outcome: RunStats['outcome'],
  economy: Partial<NonNullable<RunStats['goldEconomy']>> | null,
): RunStats {
  return {
    outcome,
    goldEconomy:
      economy === null
        ? undefined
        : {
            earnedFromDrops: 0,
            earnedFromLootBoxes: 0,
            earnedTotal: 0,
            spentOnCharm: 0,
            spentOnMerchantWeapon: 0,
            spentOnSpell: 0,
            spentTotal: 0,
            unspentAtExit: 0,
            unspentFraction: 0,
            spendableEarned: 0,
            unspentSpendable: 0,
            unspentSpendableFraction: 0,
            charmPurchases: 0,
            merchantWeaponPurchases: 0,
            spellPurchases: 0,
            distinctPurchases: 0,
            ...economy,
          },
  } as unknown as RunStats;
}

describe('median', () => {
  it('averages the two middle values for an even sample', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBe(0);
  });
});

describe('summarizeGoldEconomy', () => {
  it('summarizes winning runs only', () => {
    // A run that died never reached the shops; counting it would report the
    // loss as an economy failure.
    const summary = summarizeGoldEconomy([
      run('victory', {
        earnedTotal: 700,
        spendableEarned: 600,
        spentTotal: 400,
        spellPurchases: 1,
      }),
      run('death', { earnedTotal: 50, spendableEarned: 50, spentTotal: 0 }),
    ]);
    expect(summary?.runs).toBe(1);
    expect(summary?.medianEarnedTotal).toBe(700);
    expect(summary?.medianSpendableEarned).toBe(600);
    expect(summary?.spellPurchaseRate).toBe(1);
  });

  it('reports per-vendor purchase rates and median distinct purchases', () => {
    const summary = summarizeGoldEconomy([
      run('victory', { charmPurchases: 1, spellPurchases: 1, distinctPurchases: 2 }),
      run('victory', { charmPurchases: 1, distinctPurchases: 1 }),
      run('victory', {
        charmPurchases: 1,
        merchantWeaponPurchases: 1,
        spellPurchases: 1,
        distinctPurchases: 2,
      }),
    ]);
    expect(summary?.charmPurchaseRate).toBe(1);
    expect(summary?.weaponPurchaseRate).toBeCloseTo(1 / 3);
    expect(summary?.spellPurchaseRate).toBeCloseTo(2 / 3);
    expect(summary?.medianDistinctPurchases).toBe(2);
  });

  it('returns null when no winning run carries telemetry', () => {
    expect(summarizeGoldEconomy([])).toBeNull();
    expect(summarizeGoldEconomy([run('death', {})])).toBeNull();
    expect(summarizeGoldEconomy([run('victory', null)])).toBeNull();
    expect(formatGoldEconomySummary(null)).toEqual([
      'Gold economy: no winning runs reported telemetry',
    ]);
  });

  it('formats both the spendable and total-income unspent shares', () => {
    const lines = formatGoldEconomySummary(
      summarizeGoldEconomy([
        run('victory', {
          earnedTotal: 800,
          spendableEarned: 675,
          spentTotal: 450,
          unspentFraction: 0.4375,
          unspentSpendableFraction: 0.3333,
        }),
      ]),
    );
    expect(lines.join('\n')).toContain('33.3%');
    expect(lines.join('\n')).toContain('43.8%');
  });
});
