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
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { selectFloor1StarterWeapon } from '../../src/game/floorScenario.js';
import { equipStarterOrFallback } from '../../src/game/scenarios/starterWeaponEquip.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';

function withPlayer(): { world: GameWorld; player: number } {
  const world = createTestWorld({ seed: 7 });
  const player = spawnPlayer(world, 0, 0);
  return { world, player };
}

/**
 * Put `world` into the loadout modal state `selectFloor1StarterWeapon` expects,
 * with a deterministic starter list (index 0 = sword, 1 = bow, 2 = bat). Builds
 * a full, type-valid `Floor1ScenarioState` — the picker only reads
 * `starterChoices` and writes the selection fields, so the rest is inert.
 */
function enterLoadout(world: GameWorld, starterChoices: string[]): void {
  world.state = 'loadout';
  world.floor1 = {
    protagonistName: 'Test',
    starterWeaponPool: [],
    starterChoices,
    selectedWeaponId: null,
    selectedChoiceIndex: null,
    baseStatBonuses: { maxHp: 0, moveSpeed: 0, pickupRange: 0 },
    enemyArchetypes: new Map(),
    guideNpcEid: null,
    spellQuestGiverNpcEid: null,
    shopkeeperNpcEid: null,
    questItemEid: null,
    bossRoomDoorEids: new Map(),
    objective: {
      requiredRats: 6,
      requiredSlimes: 4,
      requiredGold: 50,
      requiredJunk: 2,
      deadlineMs: 600_000,
      staircaseSpawnCountdownMs: 30_000,
      safeRoomPos: { x: 5, y: 5 },
      staircasePos: { x: 200, y: 200 },
      welcomeOfficePos: { x: 10, y: 12 },
      slimeRatRoomPos: { x: 90, y: 30 },
      spellQuestGiverPos: { x: 150, y: 60 },
      shopRoomPos: { x: 40, y: 110 },
      questItemPos: { x: 175, y: 175 },
      markerRadiusFt: 4,
      questAccepted: false,
      questCompleted: false,
      ratsKilled: 0,
      slimesKilled: 0,
      goldCollected: 0,
      junkCollected: 0,
      safeRoomDiscovered: false,
      staircaseSpawnStartedMs: null,
      staircaseSpawnRemainingMs: null,
      staircaseSpawned: false,
      staircaseLocked: false,
      staircaseUnlocked: false,
      staircaseDiscovered: false,
      bossBattles: new Map(),
    },
    failReason: null,
    runSummary: null,
  };
}

describe('Weapon equipping', () => {
  it('lands a one-handed starter (sword) in the mainHand slot and activates it', () => {
    const { world, player } = withPlayer();
    // Configure the loadout modal state selectFloor1StarterWeapon expects.
    enterLoadout(world, ['sword', 'bow', 'baseball-bat']);

    selectFloor1StarterWeapon(world, 0);

    const state = getEquipmentState(world, player)!;
    expect(state.equipped.mainHand).not.toBeNull();
    const swordInstance = state.instances.get(state.equipped.mainHand!);
    expect(swordInstance?.def.id).toBe('iron-sword');
    // One-handed: off-hand stays free.
    expect(state.equipped.offHand).toBeNull();
    expect(getActiveWeaponDef(world)?.id).toBe('sword');
  });

  it('lands a two-handed starter (bow) in both mainHand and offHand pointing at the same instance', () => {
    const { world, player } = withPlayer();
    enterLoadout(world, ['sword', 'bow', 'baseball-bat']);

    // Bow is index 1 in the seeded starter list.
    selectFloor1StarterWeapon(world, 1);

    const state = getEquipmentState(world, player)!;
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
    const state = getEquipmentState(world, player)!;
    expect(state.equipped.mainHand).toBeNull();
    expect(state.equipped.offHand).toBeNull();
  });

  it('clears lingering hand equipment when the starter is re-selected on a reused world', () => {
    const { world, player } = withPlayer();
    enterLoadout(world, ['sword', 'bow', 'baseball-bat']);

    // First loadout: pick the sword. Lands in mainHand.
    selectFloor1StarterWeapon(world, 0);
    expect(getActiveWeaponDef(world)?.id).toBe('sword');

    // Simulate a dev tool / respawn flow that re-runs the loadout modal.
    world.state = 'loadout';
    // Now pick the two-handed bow — it wants BOTH hand slots.
    selectFloor1StarterWeapon(world, 1);

    const state = getEquipmentState(world, player)!;
    // Old sword must have been evicted; bow now owns both hand slots.
    expect(state.equipped.mainHand).not.toBeNull();
    expect(state.equipped.mainHand).toBe(state.equipped.offHand);
    const bowInstance = state.instances.get(state.equipped.mainHand!);
    expect(bowInstance?.def.id).toBe('frost-bow');
    expect(getActiveWeaponDef(world)?.id).toBe('bow');
  });
});

describe('equipStarterOrFallback', () => {
  it('equips a starter through the equipment system and reports success', () => {
    const { world, player } = withPlayer();
    const swordDef = getWeaponDef('sword')!;

    const equipped = equipStarterOrFallback(world, 'sword', swordDef);

    expect(equipped).toBe(true);
    const state = getEquipmentState(world, player)!;
    expect(state.instances.get(state.equipped.mainHand!)?.def.id).toBe('iron-sword');
    expect(getActiveWeaponDef(world)?.id).toBe('sword');
  });

  it('falls back to setActiveWeapon (reporting no equip) when there is no player entity', () => {
    // No spawnPlayer → findPlayerEid returns undefined → fallback path.
    const world = createTestWorld({ seed: 11 });
    const swordDef = getWeaponDef('sword')!;

    const equipped = equipStarterOrFallback(world, 'sword', swordDef);

    expect(equipped).toBe(false);
    expect(getActiveWeaponDef(world)?.id).toBe('sword');
  });
});
