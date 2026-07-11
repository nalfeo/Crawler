import { describe, expect, it } from 'vitest';
import { setActiveWeaponDef } from '../../src/core/active-weapon.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { computeAiStatAllocation } from '../../src/game/ai/auto-progression.js';
import {
  computeWeaponPersonaStatAllocation,
  getWeaponPersona,
  scoreEquipmentForPersona,
  WEAPON_PERSONAS,
} from '../../src/game/ai/weapon-personas.js';
import { computeAutoStatAllocation } from '../../src/game/scenarios/playerStatAllocationPolicy.js';
import type { EquipmentItemDef } from '../../src/shared/equipment-types.js';
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
    const persona = WEAPON_PERSONAS.fireball;
    const allocation = computeWeaponPersonaStatAllocation(world, playerEid, 6, persona);
    expect(allocation).toEqual({ constitution: 6 });
  });

  it('keeps legacy allocation by default and diverges only when enabled', () => {
    const world = createTestWorld({ seed: 42 });
    const playerEid = spawnPlayer(world, 0, 0);
    setActiveWeaponDef(world, getWeaponDef('bow')!);
    expect(computeAiStatAllocation(world, playerEid, 5)).toEqual(
      computeAutoStatAllocation(world, playerEid, 5),
    );
    expect(computeAiStatAllocation(world, playerEid, 5, true)).toEqual({ constitution: 5 });
  });

  it('falls back to legacy allocation for an unmapped equipped weapon', () => {
    const world = createTestWorld({ seed: 42 });
    const playerEid = spawnPlayer(world, 0, 0);
    setActiveWeaponDef(world, getWeaponDef('punch')!);
    expect(computeAiStatAllocation(world, playerEid, 8, true)).toEqual(
      computeAutoStatAllocation(world, playerEid, 8),
    );
  });

  it('ranks gear that closes a minimum-target deficit above weighted offense', () => {
    const persona = WEAPON_PERSONAS.sword;
    const constitutionGear: EquipmentItemDef = {
      id: 'test-constitution',
      name: 'Constitution Gear',
      slots: ['head'],
      statBonuses: { constitution: 1 },
      rarity: 'common',
    };
    const offenseGear: EquipmentItemDef = {
      id: 'test-offense',
      name: 'Offense Gear',
      slots: ['head'],
      statBonuses: { damagePercent: 5 },
      rarity: 'common',
    };
    expect(
      scoreEquipmentForPersona(constitutionGear, persona, { constitution: 0 }),
    ).toBeGreaterThan(scoreEquipmentForPersona(offenseGear, persona, { constitution: 0 }));
  });
});
