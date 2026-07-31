import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  createBossChestId,
  spawnBossChestForDefeatedBoss,
} from '../../src/game/boss-chest-resolver.js';
import { listGeneratedEquipmentInstances } from '../../src/core/generated-equipment-registry.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';

const FAMILY_ID = 'mirekin';
const RUN_KEY = 'boss-chest-resolver-test';

function enableFloor2Economy(world: GameWorld): void {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
}

describe('spawnBossChestForDefeatedBoss — Floor 1 exclusion', () => {
  it('never creates a chest on Floor 1, even with all flags enabled', () => {
    const world = createTestWorld({ seed: 1, floor: 1, generatedEquipmentRunKey: RUN_KEY });
    enableFloor2Economy(world);
    const result = spawnBossChestForDefeatedBoss(world, FAMILY_ID);
    expect(result).toEqual({ created: false, reason: 'notFloor2' });
    expect(world.bossChests.size).toBe(0);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
  });
});

describe('spawnBossChestForDefeatedBoss — Floor 2 gating', () => {
  it('does not create a chest when the equipment economy flag is disabled', () => {
    const world = createTestWorld({ seed: 1, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    // Flags left at default (false).
    const result = spawnBossChestForDefeatedBoss(world, FAMILY_ID);
    expect(result).toEqual({ created: false, reason: 'economyDisabled' });
    expect(world.bossChests.size).toBe(0);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
  });

  it('throws on an invalid dependency closure (economy flag on, registry/catalog missing)', () => {
    const world = createTestWorld({ seed: 1, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    // Enable only the top-level flag; leave registry+catalog false → 'invalid'.
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    expect(() => spawnBossChestForDefeatedBoss(world, FAMILY_ID)).toThrow(
      'floor2EquipmentEconomy requires floor2EquipmentRegistry and floor2EquipmentCatalog',
    );
    expect(world.bossChests.size).toBe(0);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
  });

  it('creates a deterministic chest with a resolved bundle when the economy is enabled', () => {
    const world = createTestWorld({ seed: 1, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    enableFloor2Economy(world);
    const result = spawnBossChestForDefeatedBoss(world, FAMILY_ID);
    expect(result.created).toBe(true);
    if (!result.created) return;
    const chestId = createBossChestId(FAMILY_ID);
    expect(result.chest.chestId).toBe(chestId);
    expect(result.chest.state).toBe('available');
    expect(world.bossChests.get(chestId)).toEqual(result.chest);
    const bundle = world.generatedEquipmentRewardBundles.get(chestId);
    expect(bundle).toBeDefined();
    expect(bundle!.instanceKeys).toHaveLength(1);
  });

  it('is idempotent — a second call for the same family is a no-op (alreadyExists)', () => {
    const world = createTestWorld({ seed: 1, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    enableFloor2Economy(world);
    const first = spawnBossChestForDefeatedBoss(world, FAMILY_ID);
    expect(first.created).toBe(true);
    const bundleKeysAfterFirst = [
      ...world.generatedEquipmentRewardBundles.get(createBossChestId(FAMILY_ID))!.instanceKeys,
    ];

    const second = spawnBossChestForDefeatedBoss(world, FAMILY_ID);
    expect(second).toEqual({ created: false, reason: 'alreadyExists' });
    expect([
      ...world.generatedEquipmentRewardBundles.get(createBossChestId(FAMILY_ID))!.instanceKeys,
    ]).toEqual(bundleKeysAfterFirst);
    expect(listGeneratedEquipmentInstances(world).length).toBe(1);
  });

  it('resolves deterministically for the same run key + family across worlds', () => {
    const worldA = createTestWorld({ seed: 1, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    enableFloor2Economy(worldA);
    const worldB = createTestWorld({ seed: 99, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    enableFloor2Economy(worldB);

    const resultA = spawnBossChestForDefeatedBoss(worldA, FAMILY_ID);
    const resultB = spawnBossChestForDefeatedBoss(worldB, FAMILY_ID);
    expect(resultA.created).toBe(true);
    expect(resultB.created).toBe(true);
    if (!resultA.created || !resultB.created) return;

    const chestId = createBossChestId(FAMILY_ID);
    expect(worldB.generatedEquipmentRewardBundles.get(chestId)!.instanceKeys).toEqual(
      worldA.generatedEquipmentRewardBundles.get(chestId)!.instanceKeys,
    );
  });

  it('produces distinct chest ids and bundles for different boss families', () => {
    const world = createTestWorld({ seed: 1, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    enableFloor2Economy(world);
    const first = spawnBossChestForDefeatedBoss(world, 'mirekin');
    const second = spawnBossChestForDefeatedBoss(world, 'screwheads');
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    if (!first.created || !second.created) return;
    expect(first.chest.chestId).not.toBe(second.chest.chestId);
    expect(world.bossChests.size).toBe(2);
  });

  it('falls back to the live player position when the boss position is unknown', () => {
    const world = createTestWorld({ seed: 1, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    enableFloor2Economy(world);
    const playerEid = spawnPlayer(world, 37, 19);

    const result = spawnBossChestForDefeatedBoss(world, FAMILY_ID);

    expect(result.created).toBe(true);
    if (!result.created) return;
    const chestId = createBossChestId(FAMILY_ID);
    const chestEid = world.bossChestEids.get(chestId);
    expect(chestEid).toBeDefined();
    if (chestEid === undefined) return;
    expect(world.stores.position.x[chestEid]).toBe(world.stores.position.x[playerEid]);
    expect(world.stores.position.y[chestEid]).toBe(world.stores.position.y[playerEid]);
  });
});
