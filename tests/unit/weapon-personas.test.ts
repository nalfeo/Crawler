import { describe, expect, it } from 'vitest';
import { setActiveWeaponDef } from '../../src/core/active-weapon.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { computeAiStatAllocation } from '../../src/game/ai/auto-progression.js';
import {
  computeWeaponPersonaStatAllocation,
  getWeaponPersona,
  getWeaponPersonaForWorld,
  WEAPON_PERSONAS,
} from '../../src/game/ai/weapon-personas.js';
import { computeAutoStatAllocation } from '../../src/game/scenarios/playerStatAllocationPolicy.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

const STARTING_WEAPONS = [
  'sword',
  'bow',
  'baseball-bat',
  'pistol',
  'throwing-knife',
  'fireball',
] as const;

describe('weapon AI personas', () => {
  it('defines a distinct constitution-forward profile for all six starting weapons', () => {
    const profiles = STARTING_WEAPONS.map((weaponId) => getWeaponPersona(weaponId));
    expect(profiles.every((profile) => profile !== undefined)).toBe(true);
    expect(new Set(profiles.map((profile) => profile?.name)).size).toBe(6);
    expect(new Set(profiles.map((profile) => JSON.stringify(profile?.statWeights))).size).toBe(6);
    for (const profile of profiles) {
      expect(profile?.minimumTargets.constitution).toBeGreaterThanOrEqual(5);
    }
  });

  it('satisfies minimum targets before applying weighted preferences', () => {
    const world = createTestWorld({ seed: 42 });
    const playerEid = spawnPlayer(world, 0, 0);
    const persona = WEAPON_PERSONAS.fireball!;
    const allocation = computeWeaponPersonaStatAllocation(world, playerEid, 6, persona);
    expect(allocation).toEqual({ constitution: 6 });
  });

  it('enables persona allocation by default and preserves legacy fallback when disabled', () => {
    const world = createTestWorld({ seed: 42 });
    const playerEid = spawnPlayer(world, 0, 0);
    setActiveWeaponDef(world, getWeaponDef('bow')!);

    expect(computeAiStatAllocation(world, playerEid, 8)).toEqual(
      computeAiStatAllocation(world, playerEid, 8, true),
    );
    expect(computeAiStatAllocation(world, playerEid, 8)).toEqual({
      constitution: 7,
      dexterity: 1,
    });
    expect(computeAiStatAllocation(world, playerEid, 8)).not.toEqual(
      computeAutoStatAllocation(world, playerEid, 8),
    );
    expect(computeAiStatAllocation(world, playerEid, 8, true)).toEqual({
      constitution: 7,
      dexterity: 1,
    });
    expect(computeAiStatAllocation(world, playerEid, 8, false)).toEqual(
      computeAutoStatAllocation(world, playerEid, 8),
    );
  });

  it('falls back to legacy allocation for an unmapped equipped weapon', () => {
    const world = createTestWorld({ seed: 42 });
    const playerEid = spawnPlayer(world, 0, 0);
    setActiveWeaponDef(world, getWeaponDef('punch')!);
    expect(computeAiStatAllocation(world, playerEid, 8, true)).toEqual(
      computeAutoStatAllocation(world, playerEid, 8),
    );
  });

  it('has no persona for an undefined or unmapped weapon id', () => {
    expect(getWeaponPersona(undefined)).toBeUndefined();
    expect(getWeaponPersona('not-a-weapon')).toBeUndefined();
  });

  it('resolves the world persona from the active weapon, then the scenario selection', () => {
    const world = createTestWorld({ seed: 42 });
    expect(getWeaponPersonaForWorld(world)).toBeUndefined();

    world.floorScenario = { selectedWeaponId: 'bow' } as NonNullable<typeof world.floorScenario>;
    expect(getWeaponPersonaForWorld(world)?.name).toBe('Kite Archer');

    // An equipped weapon wins over the scenario's recorded selection.
    setActiveWeaponDef(world, getWeaponDef('sword')!);
    expect(getWeaponPersonaForWorld(world)?.name).toBe('Vanguard');
  });

  it('allocates nothing for zero, negative, or non-finite point budgets', () => {
    const world = createTestWorld({ seed: 42 });
    const playerEid = spawnPlayer(world, 0, 0);
    const persona = WEAPON_PERSONAS.sword!;
    for (const available of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeWeaponPersonaStatAllocation(world, playerEid, available, persona)).toEqual({});
    }
  });

  it('floors fractional point budgets', () => {
    const world = createTestWorld({ seed: 42 });
    const playerEid = spawnPlayer(world, 0, 0);
    const persona = WEAPON_PERSONAS.sword!;
    expect(computeWeaponPersonaStatAllocation(world, playerEid, 3.9, persona)).toEqual(
      computeWeaponPersonaStatAllocation(world, playerEid, 3, persona),
    );
  });

  it('spends surplus points on weighted stats once every minimum target is met', () => {
    const world = createTestWorld({ seed: 42 });
    const playerEid = spawnPlayer(world, 0, 0);
    const persona = WEAPON_PERSONAS.pistol!;
    const allocation = computeWeaponPersonaStatAllocation(world, playerEid, 30, persona);

    const total = Object.values(allocation).reduce((sum, points) => sum + points, 0);
    expect(total).toBe(30);
    for (const [stat, target] of Object.entries(persona.minimumTargets)) {
      expect(allocation[stat as keyof typeof allocation] ?? 0).toBeGreaterThanOrEqual(target);
    }
    // Surplus goes only to stats the persona actually weights.
    for (const stat of Object.keys(allocation)) {
      const weighted = (persona.statWeights[stat as keyof typeof persona.statWeights] ?? 0) > 0;
      const required = (persona.minimumTargets[stat as keyof typeof allocation] ?? 0) > 0;
      expect(weighted || required).toBe(true);
    }
    // Luck carries the highest weight for the Gunslinger, so it leads the
    // weighted spend among the primary stats.
    expect(allocation.luck ?? 0).toBeGreaterThan(allocation.intelligence ?? 0);
  });

  it('accounts for stat points the player already has when meeting minimums', () => {
    const world = createTestWorld({ seed: 42 });
    const playerEid = spawnPlayer(world, 0, 0);
    const persona = WEAPON_PERSONAS.fireball!;
    const baseline = computeWeaponPersonaStatAllocation(world, playerEid, 6, persona);

    world.stores.coreStatPoints.constitution[playerEid] =
      (world.stores.coreStatPoints.constitution[playerEid] ?? 0) + 6;
    const afterInvestment = computeWeaponPersonaStatAllocation(world, playerEid, 6, persona);

    expect(baseline).toEqual({ constitution: 6 });
    expect(afterInvestment.constitution ?? 0).toBeLessThan(6);
    expect(Object.values(afterInvestment).reduce((sum, points) => sum + points, 0)).toBe(6);
  });
});
