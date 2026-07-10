import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { addComponent } from 'bitecs';
import { Stats } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { statsSystem, spendPoints, addStatModifier } from '../../src/game/systems/statsSystem.js';
import {
  PRIMARY_STATS,
  STAT_KEYS,
  STAT_MIN,
  isAllocatablePrimaryStat,
} from '../../src/shared/stats.js';
import { xpThresholdForLevel, xpRequiredForLevel, levelForXp } from '../../src/shared/xpMath.js';

describe('stats invariants (property-based)', () => {
  it('final stats are always >= STAT_MIN after arbitrary core-stat point allocation', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), {
          minLength: PRIMARY_STATS.length,
          maxLength: PRIMARY_STATS.length,
        }),
        (pointCounts) => {
          const world = createTestWorld({ seed: 1 });
          const player = spawnPlayer(world, 0, 0);
          addComponent(world.ecs, player, Stats);

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
          statsSystem(world);

          for (const stat of STAT_KEYS) {
            const val = world.stores.stats[stat][player] ?? 0;
            expect(val).toBeGreaterThanOrEqual(STAT_MIN[stat]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('adding a positive additive modifier never decreases a stat', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STAT_KEYS),
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        (stat, value) => {
          const world = createTestWorld({ seed: 2 });
          const player = spawnPlayer(world, 0, 0);
          addComponent(world.ecs, player, Stats);
          statsSystem(world);
          const before = world.stores.stats[stat][player] ?? 0;

          addStatModifier(world, { sourceType: 'buff', sourceId: 'test', stat, op: 'add', value });
          statsSystem(world);
          const after = world.stores.stats[stat][player] ?? 0;

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
