import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  acknowledgeBossChestReveal,
  createBossChestId,
  createBossChestRecord,
  openBossChest,
} from '../../src/core/systems/bossChestRewards.js';
import { resolveEquipmentRewardBundle } from '../../src/game/floor2-reward-bundle-resolver.js';
import { hasGeneratedEquipmentReference } from '../../src/shared/inventory.js';
import { listGeneratedEquipmentInstances } from '../../src/core/generated-equipment-registry.js';
import { createTestWorld } from '../helpers/world-factory.js';

const FAMILY_ID = 'mirekin';
const BASES = ['weapon.iron-cleaver', 'weapon.ember-wand'] as const;

function makeWorld(runKey = 'boss-chest-core-test') {
  return createTestWorld({ seed: 11, floor: 2, generatedEquipmentRunKey: runKey });
}

/** Resolve the reward bundle first (as the resolver does) then register the chest. */
function makeChestedWorld(runKey?: string) {
  const world = makeWorld(runKey);
  const chestId = createBossChestId(FAMILY_ID);
  resolveEquipmentRewardBundle(world, chestId, BASES);
  const created = createBossChestRecord(world, chestId, FAMILY_ID);
  return { world, chestId, created };
}

describe('createBossChestId', () => {
  it('is deterministic and collision-free per family', () => {
    expect(createBossChestId('mirekin')).toBe('boss-chest:mirekin');
    expect(createBossChestId('screwheads')).toBe('boss-chest:screwheads');
    expect(createBossChestId('mirekin')).not.toBe(createBossChestId('screwheads'));
  });
});

describe('createBossChestRecord', () => {
  it('fails closed with noBundle when no reward bundle exists at the chest id', () => {
    const world = makeWorld();
    const chestId = createBossChestId(FAMILY_ID);
    const result = createBossChestRecord(world, chestId, FAMILY_ID);
    expect(result).toEqual({ ok: false, reason: 'noBundle' });
    expect(world.bossChests.has(chestId)).toBe(false);
  });

  it('creates an available chest when a live bundle exists', () => {
    const { world, chestId, created } = makeChestedWorld();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.created).toBe(true);
    expect(created.chest).toEqual({
      chestId,
      familyId: FAMILY_ID,
      state: 'available',
      createdAtMs: world.elapsedMs,
    });
    expect(world.bossChests.get(chestId)).toEqual(created.chest);
  });

  it('is idempotent — a second call returns the existing record unchanged (created: false)', () => {
    const { world, chestId, created } = makeChestedWorld();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Advance the deterministic clock so a re-create-from-scratch would be detectable.
    world.elapsedMs += 1000;
    const second = createBossChestRecord(world, chestId, FAMILY_ID);
    expect(second).toEqual({ ok: true, created: false, chest: created.chest });
    expect(world.bossChests.get(chestId)!.createdAtMs).toBe(created.chest.createdAtMs);
  });
});

describe('openBossChest', () => {
  it('fails closed with unknownChest for a chest id that was never created', () => {
    const world = makeWorld();
    const playerEid = spawnPlayer(world, 0, 0);
    expect(openBossChest(world, createBossChestId(FAMILY_ID), playerEid)).toEqual({
      ok: false,
      reason: 'unknownChest',
    });
  });

  it('transitions available -> revealed and grants the bundle via the shared atomic claim path', () => {
    const { world, chestId } = makeChestedWorld();
    const playerEid = spawnPlayer(world, 0, 0);
    const instanceCountBefore = listGeneratedEquipmentInstances(world).length;
    const bundleKeys = [...world.generatedEquipmentRewardBundles.get(chestId)!.instanceKeys];

    const result = openBossChest(world, chestId, playerEid);
    expect(result).toEqual({
      ok: true,
      alreadyClaimed: false,
      state: 'revealed',
      granted: expect.any(Array),
    });
    expect(world.bossChests.get(chestId)!.state).toBe('revealed');
    // Claim never invokes the generator.
    expect(listGeneratedEquipmentInstances(world).length).toBe(instanceCountBefore);
    expect(world.generatedEquipmentRewardBundles.has(chestId)).toBe(false);
    const bag = world.inventories.get(playerEid)!;
    for (const key of bundleKeys) {
      expect(hasGeneratedEquipmentReference(bag, key)).toBe(true);
    }
  });

  it('reverts to available (retryable) and preserves the bundle when the grant fails (e.g. bag full)', () => {
    const { world, chestId } = makeChestedWorld('boss-chest-grant-fail');
    const playerEid = spawnPlayer(world, 0, 0);
    const bag = world.inventories.get(playerEid)!;
    world.inventories.set(playerEid, { ...bag, generatedEquipmentCapacity: 0 });

    const result = openBossChest(world, chestId, playerEid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('grantFailed');
    expect(world.bossChests.get(chestId)!.state).toBe('available');
    expect(world.generatedEquipmentRewardBundles.has(chestId)).toBe(true);
  });

  it('is idempotent — re-opening a revealed chest is a no-op success without re-touching the generator', () => {
    const { world, chestId } = makeChestedWorld('boss-chest-reopen');
    const playerEid = spawnPlayer(world, 0, 0);
    const first = openBossChest(world, chestId, playerEid);
    expect(first.ok).toBe(true);
    const instanceCountAfterFirst = listGeneratedEquipmentInstances(world).length;

    const second = openBossChest(world, chestId, playerEid);
    expect(second).toEqual({ ok: true, alreadyClaimed: true, state: 'revealed' });
    expect(listGeneratedEquipmentInstances(world).length).toBe(instanceCountAfterFirst);
  });

  it('is idempotent — re-opening a claimed chest is a no-op success', () => {
    const { world, chestId } = makeChestedWorld('boss-chest-reopen-claimed');
    const playerEid = spawnPlayer(world, 0, 0);
    expect(openBossChest(world, chestId, playerEid).ok).toBe(true);
    expect(acknowledgeBossChestReveal(world, chestId)).toEqual({ ok: true, alreadyClaimed: false });

    const result = openBossChest(world, chestId, playerEid);
    expect(result).toEqual({ ok: true, alreadyClaimed: true, state: 'claimed' });
  });
});

describe('acknowledgeBossChestReveal', () => {
  it('fails closed with unknownChest for an unregistered chest', () => {
    const world = makeWorld();
    expect(acknowledgeBossChestReveal(world, createBossChestId(FAMILY_ID))).toEqual({
      ok: false,
      reason: 'unknownChest',
    });
  });

  it('fails closed with invalidTransition when the chest was never revealed (still available)', () => {
    const { world, chestId } = makeChestedWorld();
    expect(acknowledgeBossChestReveal(world, chestId)).toEqual({
      ok: false,
      reason: 'invalidTransition',
    });
    expect(world.bossChests.get(chestId)!.state).toBe('available');
  });

  it('transitions revealed -> claimed (terminal)', () => {
    const { world, chestId } = makeChestedWorld('boss-chest-ack');
    const playerEid = spawnPlayer(world, 0, 0);
    openBossChest(world, chestId, playerEid);
    const result = acknowledgeBossChestReveal(world, chestId);
    expect(result).toEqual({ ok: true, alreadyClaimed: false });
    expect(world.bossChests.get(chestId)!.state).toBe('claimed');
  });

  it('is idempotent — acknowledging an already-claimed chest returns success with alreadyClaimed: true', () => {
    const { world, chestId } = makeChestedWorld('boss-chest-ack-twice');
    const playerEid = spawnPlayer(world, 0, 0);
    openBossChest(world, chestId, playerEid);
    acknowledgeBossChestReveal(world, chestId);
    const second = acknowledgeBossChestReveal(world, chestId);
    expect(second).toEqual({ ok: true, alreadyClaimed: true });
    expect(world.bossChests.get(chestId)!.state).toBe('claimed');
  });
});
