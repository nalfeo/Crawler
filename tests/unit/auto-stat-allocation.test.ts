import { describe, expect, it } from 'vitest';
import { computeAutoStatAllocation } from '../../src/game/ai/auto-progression.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * `computeAutoStatAllocation` is the pure decision the AI playthrough feeds into
 * BOTH the headless runner (`spendPoints`) and the in-browser level-up modal
 * (`LevelUpUI.autoResolve`). The survival-tiered spend order is: armor→5,
 * maxHp→6, armor→11, then dump the remainder into maxHp.
 */
describe('computeAutoStatAllocation', () => {
  const setup = () => {
    const world = createTestWorld();
    const playerEid = spawnPlayer(world, 0, 0);
    return { world, playerEid };
  };

  it('returns no allocation when there are no points to spend', () => {
    const { world, playerEid } = setup();
    expect(computeAutoStatAllocation(world, playerEid, 0)).toEqual({});
  });

  it('clamps non-finite / negative availability to an empty allocation', () => {
    const { world, playerEid } = setup();
    expect(computeAutoStatAllocation(world, playerEid, -3)).toEqual({});
    expect(computeAutoStatAllocation(world, playerEid, Number.NaN)).toEqual({});
  });

  it('front-loads armor up to the swarm floor (5) for a fresh player', () => {
    const { world, playerEid } = setup();
    expect(computeAutoStatAllocation(world, playerEid, 3)).toEqual({ armor: 3 });
    expect(computeAutoStatAllocation(world, playerEid, 5)).toEqual({ armor: 5 });
  });

  it('banks the maxHp cushion (6) after the swarm floor', () => {
    const { world, playerEid } = setup();
    expect(computeAutoStatAllocation(world, playerEid, 11)).toEqual({ armor: 5, maxHp: 6 });
  });

  it('tops armor toward the boss target before dumping the rest into maxHp', () => {
    const { world, playerEid } = setup();
    expect(computeAutoStatAllocation(world, playerEid, 12)).toEqual({ armor: 6, maxHp: 6 });
    expect(computeAutoStatAllocation(world, playerEid, 20)).toEqual({ armor: 11, maxHp: 9 });
  });

  it('accounts for points already spent on a stat', () => {
    const { world, playerEid } = setup();
    world.stores.statPoints.armor[playerEid] = 5;
    expect(computeAutoStatAllocation(world, playerEid, 6)).toEqual({ maxHp: 6 });
  });

  it('never spends more than the available points', () => {
    const { world, playerEid } = setup();
    for (const available of [1, 4, 7, 13, 25]) {
      const allocation = computeAutoStatAllocation(world, playerEid, available);
      const total = Object.values(allocation).reduce((sum, n) => sum + (n ?? 0), 0);
      expect(total).toBe(available);
    }
  });

  it('does not mutate the stat-point stores (pure computation)', () => {
    const { world, playerEid } = setup();
    computeAutoStatAllocation(world, playerEid, 20);
    expect(world.stores.statPoints.armor[playerEid]).toBe(0);
    expect(world.stores.statPoints.maxHp[playerEid]).toBe(0);
  });
});
