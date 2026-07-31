import { entityExists } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { spawnBossChestEntity } from '../../src/core/spawners/world-objects.js';
import {
  bossChestPickupSystem,
} from '../../src/core/systems/bossChestPickupSystem.js';
import {
  createBossChestId,
  createBossChestRecord,
} from '../../src/core/systems/bossChestRewards.js';
import { resolveEquipmentRewardBundle } from '../../src/game/floor2-reward-bundle-resolver.js';
import { createTestWorld } from '../helpers/world-factory.js';

const FAMILY_ID = 'mirekin';
// Two bases with different affinities so the non-aligned pool is always non-empty
// regardless of the player's starting affinity. Matches bossChestRewards.test.ts.
const BASES = ['weapon.iron-cleaver', 'weapon.ember-wand'] as const;
const CHEST_X = 10;
const CHEST_Y = 10;
const BOSS_CHEST_RANGE_FT = 4;

function makeWorld(runKey = 'boss-chest-pickup-test') {
  return createTestWorld({ seed: 11, floor: 2, generatedEquipmentRunKey: runKey });
}

/** Sets up a world with a registered, available boss chest entity at (CHEST_X, CHEST_Y). */
function setupWorldWithChest(runKey?: string) {
  const world = makeWorld(runKey);
  const chestId = createBossChestId(FAMILY_ID);
  resolveEquipmentRewardBundle(world, chestId, BASES, 'tier4');
  createBossChestRecord(world, chestId, FAMILY_ID);
  const chestEid = spawnBossChestEntity(world, CHEST_X, CHEST_Y, chestId);
  return { world, chestId, chestEid };
}

describe('bossChestPickupSystem — no-op conditions', () => {
  it('does nothing when there is no player in the world', () => {
    const { world, chestId, chestEid } = setupWorldWithChest();
    bossChestPickupSystem(world);
    expect(entityExists(world.ecs, chestEid)).toBe(true);
    expect(world.bossChestEids.has(chestId)).toBe(true);
    expect(world.bossChests.get(chestId)!.state).toBe('available');
  });

  it('does nothing when the player is beyond pickup range', () => {
    const { world, chestId, chestEid } = setupWorldWithChest('pickup-out-of-range');
    const farX = CHEST_X + BOSS_CHEST_RANGE_FT + 1;
    spawnPlayer(world, farX, CHEST_Y);

    bossChestPickupSystem(world);

    expect(entityExists(world.ecs, chestEid)).toBe(true);
    expect(world.bossChestEids.has(chestId)).toBe(true);
    expect(world.bossChests.get(chestId)!.state).toBe('available');
  });

  it('does nothing when the world has no chests registered', () => {
    const world = makeWorld('pickup-no-chests');
    spawnPlayer(world, CHEST_X, CHEST_Y);
    expect(() => bossChestPickupSystem(world)).not.toThrow();
  });
});

describe('bossChestPickupSystem — successful pickup', () => {
  it('opens the chest and removes the entity when player is exactly on the chest', () => {
    const { world, chestId, chestEid } = setupWorldWithChest('pickup-exact');
    const playerEid = spawnPlayer(world, CHEST_X, CHEST_Y);

    bossChestPickupSystem(world);

    // Entity removed
    expect(entityExists(world.ecs, chestEid)).toBe(false);
    // Sidecar map cleaned up
    expect(world.bossChestEids.has(chestId)).toBe(false);
    // Chest state transitioned to 'revealed'
    expect(world.bossChests.get(chestId)!.state).toBe('revealed');
    // Items granted to player
    const bag = world.inventories.get(playerEid);
    expect(bag).toBeDefined();
  });

  it('opens the chest when player is at the edge of the pickup range', () => {
    const { world, chestId, chestEid } = setupWorldWithChest('pickup-edge');
    // Place player exactly BOSS_CHEST_RANGE_FT away horizontally
    spawnPlayer(world, CHEST_X + BOSS_CHEST_RANGE_FT, CHEST_Y);

    bossChestPickupSystem(world);

    expect(entityExists(world.ecs, chestEid)).toBe(false);
    expect(world.bossChestEids.has(chestId)).toBe(false);
    expect(world.bossChests.get(chestId)!.state).toBe('revealed');
  });

  it('does not pick up when player is just beyond the edge of range', () => {
    const { world, chestId, chestEid } = setupWorldWithChest('pickup-just-beyond');
    spawnPlayer(world, CHEST_X + BOSS_CHEST_RANGE_FT + 0.01, CHEST_Y);

    bossChestPickupSystem(world);

    expect(entityExists(world.ecs, chestEid)).toBe(true);
    expect(world.bossChests.get(chestId)!.state).toBe('available');
  });
});

describe('bossChestPickupSystem — grantFailed (bag full) leaves entity', () => {
  it('leaves the entity in place so the player can retry', () => {
    const { world, chestId, chestEid } = setupWorldWithChest('pickup-grant-fail');
    const playerEid = spawnPlayer(world, CHEST_X, CHEST_Y);
    const bag = world.inventories.get(playerEid)!;
    world.inventories.set(playerEid, { ...bag, generatedEquipmentCapacity: 0 });

    bossChestPickupSystem(world);

    // Entity must remain — player can retry after making room
    expect(entityExists(world.ecs, chestEid)).toBe(true);
    expect(world.bossChestEids.has(chestId)).toBe(true);
    // Chest reverts to 'available'
    expect(world.bossChests.get(chestId)!.state).toBe('available');
  });
});

describe('bossChestPickupSystem — already-claimed chest', () => {
  it('removes the lingering entity when the chest is already claimed (alreadyClaimed)', () => {
    const { world, chestId, chestEid } = setupWorldWithChest('pickup-already-claimed');
    const playerEid = spawnPlayer(world, CHEST_X + BOSS_CHEST_RANGE_FT + 10, CHEST_Y);

    // Simulate chest already opened via another path (force state to 'revealed')
    const chest = world.bossChests.get(chestId)!;
    chest.state = 'revealed';

    // Now bring the player close
    world.stores.position.x[playerEid] = CHEST_X;
    world.stores.position.y[playerEid] = CHEST_Y;

    bossChestPickupSystem(world);

    // Entity removed — no stuck ghost chest
    expect(entityExists(world.ecs, chestEid)).toBe(false);
    expect(world.bossChestEids.has(chestId)).toBe(false);
  });
});

describe('bossChestPickupSystem — stale sidecar entries', () => {
  it('cleans up stale sidecar entries where the entity was already removed externally', () => {
    const world = makeWorld('pickup-stale-sidecar');
    const chestId = createBossChestId(FAMILY_ID);
    // Deliberately register a sidecar entry for an eid that was never created
    // (simulates an entity removed by another code path without clearing the map).
    world.bossChestEids.set(chestId, 9999);
    spawnPlayer(world, CHEST_X, CHEST_Y);

    bossChestPickupSystem(world);

    // Stale entry should be pruned
    expect(world.bossChestEids.has(chestId)).toBe(false);
  });
});
