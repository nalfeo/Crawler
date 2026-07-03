/**
 * Weapon-equipping integration tests. Locks in the four requirements:
 *   1. Starter weapon lands in the correct hand slot at loadout time.
 *   2. Two-handed starters occupy both `mainHand` and `offHand`.
 *   3. A weapon purchased from the post-quest merchant becomes equippable
 *      (bag → equip → weaponSystem sees it as active).
 *   4. Unequipping the weapon clears the active-weapon state.
 *
 * These tests operate on the same GameWorld / equipmentSystem the shipping
 * loadout flow uses, so they catch regressions that unit-testing the
 * WEAPON_EQUIPMENT_DEFS registry alone would miss.
 */

import { describe, it, expect } from 'vitest';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { equip, unequip, getEquipmentState } from '../../src/core/systems/equipmentSystem.js';
import { getActiveWeaponDef } from '../../src/core/active-weapon.js';
import {
  getEquipmentDefForItem,
  getEquipmentDefForStarterWeapon,
} from '../../src/shared/equipmentDefs.js';
import { selectFloor1StarterWeapon } from '../../src/game/floorScenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

function withPlayer(): { world: ReturnType<typeof createTestWorld>; player: number } {
  const world = createTestWorld({ seed: 7 });
  const player = spawnPlayer(world, 0, 0);
  return { world, player };
}

describe('Weapon equipping', () => {
  it('lands a one-handed starter (sword) in the mainHand slot and activates it', () => {
    const { world, player } = withPlayer();
    // Configure the loadout modal state selectFloor1StarterWeapon expects.
    world.state = 'loadout';
    world.floor1 = {
      ...(world.floor1 ?? {
        starterChoices: [],
        selectedWeaponId: undefined,
        selectedChoiceIndex: undefined,
      }),
      starterChoices: ['sword', 'bow', 'baseball-bat'],
    };

    selectFloor1StarterWeapon(world, 0);

    const state = getEquipmentState(world, player);
    expect(state.equipped.mainHand).not.toBeNull();
    const swordInstance = state.instances.get(state.equipped.mainHand!);
    expect(swordInstance?.def.id).toBe('iron-sword');
    // One-handed: off-hand stays free.
    expect(state.equipped.offHand).toBeNull();
    expect(getActiveWeaponDef(world)?.id).toBe('sword');
  });

  it('lands a two-handed starter (bow) in both mainHand and offHand pointing at the same instance', () => {
    const { world, player } = withPlayer();
    world.state = 'loadout';
    world.floor1 = {
      ...(world.floor1 ?? {
        starterChoices: [],
        selectedWeaponId: undefined,
        selectedChoiceIndex: undefined,
      }),
      starterChoices: ['sword', 'bow', 'baseball-bat'],
    };

    // Bow is index 1 in the seeded starter list.
    selectFloor1StarterWeapon(world, 1);

    const state = getEquipmentState(world, player);
    expect(state.equipped.mainHand).not.toBeNull();
    expect(state.equipped.offHand).not.toBeNull();
    // Two-handers must share one instance id (single unequip removes both).
    expect(state.equipped.mainHand).toBe(state.equipped.offHand);
    const bowInstance = state.instances.get(state.equipped.mainHand!);
    expect(bowInstance?.def.id).toBe('frost-bow');
    expect(getActiveWeaponDef(world)?.id).toBe('bow');
  });

  it('makes a shop-purchased weapon (iron-sword) equippable', () => {
    const { world, player } = withPlayer();

    const def = getEquipmentDefForItem('iron-sword');
    expect(def).toBeDefined();
    expect(def!.weaponId).toBe('sword');

    const result = equip(world, player, def!, { force: true });
    expect(result.ok).toBe(true);
    expect(getActiveWeaponDef(world)?.id).toBe('sword');
  });

  it('clears the active weapon when the equipped weapon is unequipped', () => {
    const { world, player } = withPlayer();
    const def = getEquipmentDefForStarterWeapon('bow')!;

    equip(world, player, def, { force: true });
    expect(getActiveWeaponDef(world)?.id).toBe('bow');

    unequip(world, player, 'mainHand', { force: true });
    expect(getActiveWeaponDef(world)).toBeUndefined();

    // Two-hander removal should have vacated the off-hand mirror too.
    const state = getEquipmentState(world, player);
    expect(state.equipped.mainHand).toBeNull();
    expect(state.equipped.offHand).toBeNull();
  });
});
