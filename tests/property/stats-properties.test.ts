import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/index.js';
import { spendPoints, addStatModifier } from '../../src/game/systems/statsSystem.js';
import {
  PRIMARY_STATS,
  ALL_STAT_IDS,
  STAT_KEYS,
  STAT_CLAMPS,
  isAllocatablePrimaryStat,
  type StatKey,
  type SecondaryStatId,
} from '../../src/shared/stats.js';
import { xpThresholdForLevel, xpRequiredForLevel, levelForXp } from '../../src/shared/xpMath.js';

/**
 * Legacy `StatModifier`/`CatalogEffect` targets (`StatKey`) fold into
 * EffectiveStats via `foldLegacyStatModifier` — every key maps to the
 * same-named EffectiveStats field EXCEPT `damage`, which splits into flat
 * `damageBonus` (additive) — see `shared/stats.ts`.
 */
function effectiveStatsFieldFor(stat: StatKey): SecondaryStatId {
  return stat === 'damage' ? 'damageBonus' : (stat as SecondaryStatId);
}

describe('stats invariants (property-based)', () => {
  it('every EffectiveStats field respects its configured clamp after arbitrary core-stat point allocation', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), {
          minLength: PRIMARY_STATS.length,
          maxLength: PRIMARY_STATS.length,
        }),
        (pointCounts) => {
          const world = createTestWorld({ seed: 1 });
          const player = spawnPlayer(world, 0, 0);
          initializeBaseStats(world, player);

          const totalPoints = pointCounts.reduce((a, b) => a + b, 0);
          world.playerLevel.unspentPoints = totalPoints;

          const allocations: Partial<Record<(typeof PRIMARY_STATS)[number], number>> = {};
          for (let i = 0; i < PRIMARY_STATS.length; i++) {
            const key = PRIMARY_STATS[i]!;
            if (!isAllocatablePrimaryStat(key)) continue;
            if ((pointCounts[i] ?? 0) > 0) {
              allocations[key] = pointCounts[i];
            }
          }

          spendPoints(world, allocations);
          statSystem(world);

          for (const stat of ALL_STAT_IDS) {
            const val = world.stores.effectiveStats[stat][player] ?? 0;
            const clamp = STAT_CLAMPS[stat];
            if (clamp.min !== undefined) expect(val).toBeGreaterThanOrEqual(clamp.min);
            if (clamp.max !== undefined) expect(val).toBeLessThanOrEqual(clamp.max);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('adding a positive additive legacy modifier never decreases its folded EffectiveStats field', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STAT_KEYS),
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        (stat, value) => {
          const world = createTestWorld({ seed: 2 });
          const player = spawnPlayer(world, 0, 0);
          initializeBaseStats(world, player);
          statSystem(world);
          const field = effectiveStatsFieldFor(stat);
          const before = world.stores.effectiveStats[field][player] ?? 0;

          addStatModifier(world, { sourceType: 'buff', sourceId: 'test', stat, op: 'add', value });
          statSystem(world);
          const after = world.stores.effectiveStats[field][player] ?? 0;

          expect(after).toBeGreaterThanOrEqual(before);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('XP math invariants (property-based)', () => {
  it('levelForXp(xpRequiredForLevel(n)) === n for all n 0..50', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (level) => {
        const xp = xpRequiredForLevel(level);
        expect(levelForXp(xp)).toBe(level);
      }),
    );
  });

  it('xpThresholdForLevel is strictly non-decreasing', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 98 }), (level) => {
        expect(xpThresholdForLevel(level + 1)).toBeGreaterThanOrEqual(xpThresholdForLevel(level));
      }),
    );
  });

  it('xpRequiredForLevel is strictly increasing', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 49 }), (level) => {
        expect(xpRequiredForLevel(level + 1)).toBeGreaterThan(xpRequiredForLevel(level));
      }),
    );
  });
});
