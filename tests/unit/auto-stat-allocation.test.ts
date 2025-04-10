import { describe, expect, it } from 'vitest';
import { computeAutoStatAllocation } from '../../src/game/ai/auto-progression.js';
import { setActiveWeaponDef } from '../../src/core/active-weapon.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { WEAPON_DEFS } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * `computeAutoStatAllocation` is the pure decision the AI playthrough feeds into
 * BOTH the headless runner (`spendPoints`) and the in-browser level-up modal
 * (`LevelUpUI.autoResolve`). Per the stat-system overhaul (plan resolution
 * #11), the shared survival-tiered spend order is:
 *   1. Constitution → 8 (maxHp heals on spend, see core/systems/statSystem.ts)
 *   2. Dexterity → 5
 *   3. Offense (Strength for a physical weapon, Intelligence for a magic one
 *      — e.g. the starter fireball wand) → 5
 *   4. Wisdom → 5
 *   5. Offense → 11
 *   6. Constitution for the remainder
 * Physical vs magic ONLY changes which primary stat "offense" targets — every
 * other stat/target/order is identical.
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

  it('front-loads constitution to replace the survivability lost with Strength armor', () => {
    const { world, playerEid } = setup();
    expect(computeAutoStatAllocation(world, playerEid, 3)).toEqual({ constitution: 3 });
    expect(computeAutoStatAllocation(world, playerEid, 8)).toEqual({ constitution: 8 });
  });

  it('builds shared dexterity after the constitution survival target', () => {
    const { world, playerEid } = setup();
    expect(computeAutoStatAllocation(world, playerEid, 11)).toEqual({
      constitution: 8,
      dexterity: 3,
    });
  });

  it('spends offense then wisdom after the shared survival stats', () => {
    const { world, playerEid } = setup();
    // 8 (con) + 4 into dexterity
    expect(computeAutoStatAllocation(world, playerEid, 12)).toEqual({
      constitution: 8,
      dexterity: 4,
    });
    // 8 + 5 (dex full) + 5 (offense) + 2 into wisdom
    expect(computeAutoStatAllocation(world, playerEid, 20)).toEqual({
      constitution: 8,
      dexterity: 5,
      strength: 5,
      wisdom: 2,
    });
  });

  it('tops offense toward the boss target (11) then dumps the rest into constitution', () => {
    const { world, playerEid } = setup();
    // 8 (con) + 5 (offense) + 5 (dex) + 5 (wis) + 6 more offense = 11 total offense.
    expect(computeAutoStatAllocation(world, playerEid, 29)).toEqual({
      constitution: 8,
      dexterity: 5,
      strength: 11,
      wisdom: 5,
    });
    // Beyond 29, every extra point dumps into constitution.
    expect(computeAutoStatAllocation(world, playerEid, 30)).toEqual({
      constitution: 9,
      dexterity: 5,
      strength: 11,
      wisdom: 5,
    });
  });

  it('spends offense into Intelligence instead of Strength when a magic weapon is active', () => {
    const { world, playerEid } = setup();
    setActiveWeaponDef(world, WEAPON_DEFS.get('fireball')!);
    expect(computeAutoStatAllocation(world, playerEid, 3)).toEqual({ constitution: 3 });
    expect(computeAutoStatAllocation(world, playerEid, 29)).toEqual({
      constitution: 8,
      dexterity: 5,
      intelligence: 11,
      wisdom: 5,
    });
  });

  it('spends offense into Strength for a non-magic (ranged) weapon', () => {
    const { world, playerEid } = setup();
    setActiveWeaponDef(world, WEAPON_DEFS.get('bow')!);
    expect(computeAutoStatAllocation(world, playerEid, 9)).toEqual({
      constitution: 8,
      dexterity: 1,
    });
  });

  it('accounts for core stat points already spent', () => {
    const { world, playerEid } = setup();
    world.stores.coreStatPoints.strength[playerEid] = 5;
    expect(computeAutoStatAllocation(world, playerEid, 6)).toEqual({ constitution: 6 });
  });

  it('never spends more than the available points', () => {
    const { world, playerEid } = setup();
    for (const available of [1, 4, 7, 13, 25, 40]) {
      const allocation = computeAutoStatAllocation(world, playerEid, available);
      const total = Object.values(allocation).reduce((sum, n) => sum + (n ?? 0), 0);
      expect(total).toBe(available);
    }
  });

  it('does not mutate the core stat-point stores (pure computation)', () => {
    const { world, playerEid } = setup();
    computeAutoStatAllocation(world, playerEid, 20);
    expect(world.stores.coreStatPoints.strength[playerEid]).toBe(0);
    expect(world.stores.coreStatPoints.constitution[playerEid]).toBe(0);
    expect(world.stores.coreStatPoints.dexterity[playerEid]).toBe(0);
    expect(world.stores.coreStatPoints.wisdom[playerEid]).toBe(0);
  });
});
