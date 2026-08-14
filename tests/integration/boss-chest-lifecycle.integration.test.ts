import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { floor2ObjectiveTick, initializeFloor2Bosses } from '../../src/game/floor2Scenario.js';
import {
  spawnBossChestForDefeatedBoss,
  openBossChest,
  acknowledgeBossChestReveal,
  createBossChestId,
} from '../../src/game/boss-chest-resolver.js';
import { asFamilyId, selectFloor2Roster } from '../../src/core/faction-relations.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';
import { createInputState } from '../../src/shared/input.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { capturePlayerCarryover, restorePlayerCarryover } from '../../src/game/playerCarryover.js';
import { listGeneratedEquipmentInstances } from '../../src/core/generated-equipment-registry.js';
import { hasGeneratedEquipmentReference } from '../../src/shared/inventory.js';
import type { GameWorld } from '../../src/core/world.js';

type DeepWriteable<T> = T extends object ? { -readonly [K in keyof T]: DeepWriteable<T[K]> } : T;

function mutableClone<T>(value: T): DeepWriteable<T> {
  return structuredClone(value) as DeepWriteable<T>;
}

function smallCaveConfig(seed: number): MapConfig {
  return {
    widthTiles: 80,
    heightTiles: 60,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

function enableFloor2Economy(world: GameWorld): void {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
}

/**
 * Build a real Floor 2 world (cave map + boss roster via `initializeFloor2Bosses`,
 * same as `floor2-victory-pipeline.test.ts`) with the equipment economy enabled
 * and a player spawned. Returns the first present family's id so the caller can
 * drive a real boss-death event for it.
 */
function setupFloor2World(
  seed: number,
  runKey: string,
): { world: GameWorld; playerEid: number; familyId: string } {
  const gen = new CaveSystemGenerator({ presentCount: 3 });
  const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
  const world = createTestWorld({ seed, floor: 2, generatedEquipmentRunKey: runKey });
  world.floorMap = floorMap;
  enableFloor2Economy(world);
  const families = loadFamilies();
  const resources = loadResources();
  const roster = selectFloor2Roster(new SeededRandom(seed), families, resources, {
    presentCountFourProbability: 0,
  });
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [...roster.presentFamilies],
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
    },
  };
  const objectives = initializeFloor2Bosses(
    world,
    floorMap,
    world.floorExtendedState!.familyState!,
  );
  expect(objectives.length).toBeGreaterThan(0);
  const playerEid = spawnPlayer(world, 0, 0);
  const familyId = objectives[0]!.familyId;
  return { world, playerEid, familyId };
}

/** Push a real boss-death combat event for `familyId` and drive the real objective pipeline. */
function killBossFamily(world: GameWorld, familyId: string): void {
  const bossField = world.stores.familyMembership.isBoss;
  const familyIdxField = world.stores.familyMembership.familyId;
  const presentIndex = world.floorExtendedState!.familyState!.presentFamilies.indexOf(
    asFamilyId(familyId),
  );
  expect(presentIndex).toBeGreaterThanOrEqual(0);
  let bossEid = -1;
  for (let eid = 0; eid < bossField.length; eid++) {
    if (bossField[eid] === 1 && familyIdxField[eid] === presentIndex) {
      bossEid = eid;
      break;
    }
  }
  expect(bossEid).toBeGreaterThan(0);
  world.combatEvents.push({
    type: 'death',
    x: 0,
    y: 0,
    amount: 999,
    targetType: 'enemy',
    timestamp: world.elapsedMs,
    targetEid: bossEid,
  } as (typeof world.combatEvents)[number]);

  world.floorObjectiveTick = floor2ObjectiveTick;
  const floor2Options = createFloorMainSceneOptions('floor2');
  runSimulationStep(world, createInputState(), 16, { postSystems: floor2Options.postSystems });
}

describe('Boss chest lifecycle — real Floor 2 defeat pipeline (observe real artifact)', () => {
  it('creates an available chest with a resolved bundle when the real objective tick sees a boss death', () => {
    const { world, familyId } = setupFloor2World(11, 'boss-chest-it-real');
    const chestId = createBossChestId(familyId);
    expect(world.bossChests.has(chestId)).toBe(false);

    killBossFamily(world, familyId);

    const chest = world.bossChests.get(chestId);
    expect(chest).toBeDefined();
    expect(chest!.state).toBe('available');
    const bundle = world.generatedEquipmentRewardBundles.get(chestId);
    expect(bundle).toBeDefined();
    expect(bundle!.instanceKeys).toHaveLength(1);
  });

  it('does not create a chest for a boss family that has not died', () => {
    const { world, familyId } = setupFloor2World(12, 'boss-chest-it-untouched');
    const otherFamilyId = world.floorExtendedState!.familyState!.presentFamilies.find(
      (id) => id !== familyId,
    )!;
    expect(otherFamilyId).toBeDefined();

    killBossFamily(world, familyId);

    expect(world.bossChests.has(createBossChestId(familyId))).toBe(true);
    expect(world.bossChests.has(createBossChestId(otherFamilyId))).toBe(false);
  });
});

describe('Boss chest lifecycle — open/acknowledge lifecycle ordering + duplicate idempotency', () => {
  it('runs available → opening → revealed → claimed exactly once, then is idempotent on re-open/re-acknowledge', () => {
    const { world, playerEid, familyId } = setupFloor2World(13, 'boss-chest-it-lifecycle');
    killBossFamily(world, familyId);
    const chestId = createBossChestId(familyId);
    const bundleKeys = [...world.generatedEquipmentRewardBundles.get(chestId)!.instanceKeys];
    const instanceCountBeforeOpen = listGeneratedEquipmentInstances(world).length;

    const openResult = openBossChest(world, chestId, playerEid);
    expect(openResult).toMatchObject({ ok: true, alreadyClaimed: false, state: 'revealed' });
    if (openResult.ok) {
      expect(openResult.granted).toHaveLength(1);
    }
    expect(world.bossChests.get(chestId)!.state).toBe('revealed');
    // Atomic claim: never invokes the generator, so the registry's instance
    // count is unchanged; the bundle is consumed (deleted) on success.
    expect(listGeneratedEquipmentInstances(world).length).toBe(instanceCountBeforeOpen);
    expect(world.generatedEquipmentRewardBundles.has(chestId)).toBe(false);
    const bag = world.inventories.get(playerEid)!;
    for (const key of bundleKeys) {
      expect(hasGeneratedEquipmentReference(bag, key)).toBe(true);
    }

    // Duplicate open on a revealed chest is an idempotent no-op success.
    const secondOpen = openBossChest(world, chestId, playerEid);
    expect(secondOpen).toEqual({ ok: true, alreadyClaimed: true, state: 'revealed' });
    expect(world.bossChests.get(chestId)!.state).toBe('revealed');

    const ack = acknowledgeBossChestReveal(world, chestId);
    expect(ack).toEqual({ ok: true, alreadyClaimed: false });
    expect(world.bossChests.get(chestId)!.state).toBe('claimed');

    // Duplicate acknowledge on a claimed chest is an idempotent no-op success.
    const secondAck = acknowledgeBossChestReveal(world, chestId);
    expect(secondAck).toEqual({ ok: true, alreadyClaimed: true });
    expect(world.bossChests.get(chestId)!.state).toBe('claimed');

    // Duplicate open on a claimed chest is also an idempotent no-op success
    // (never re-touches RNG/generator, never re-grants).
    const openAfterClaim = openBossChest(world, chestId, playerEid);
    expect(openAfterClaim).toEqual({ ok: true, alreadyClaimed: true, state: 'claimed' });
    expect(listGeneratedEquipmentInstances(world).length).toBe(instanceCountBeforeOpen);
  });

  it('fail-closed: acknowledging an available (unopened) chest is an invalid transition', () => {
    const { world, familyId } = setupFloor2World(14, 'boss-chest-it-invalid-ack');
    killBossFamily(world, familyId);
    const chestId = createBossChestId(familyId);
    expect(world.bossChests.get(chestId)!.state).toBe('available');

    const ack = acknowledgeBossChestReveal(world, chestId);
    expect(ack).toEqual({ ok: false, reason: 'invalidTransition' });
    expect(world.bossChests.get(chestId)!.state).toBe('available');
  });

  it('fail-closed: opening/acknowledging an unknown chest id is rejected', () => {
    const { world, playerEid } = setupFloor2World(15, 'boss-chest-it-unknown');
    const unknownChestId = createBossChestId('no-such-family');
    expect(openBossChest(world, unknownChestId, playerEid)).toEqual({
      ok: false,
      reason: 'unknownChest',
    });
    expect(acknowledgeBossChestReveal(world, unknownChestId)).toEqual({
      ok: false,
      reason: 'unknownChest',
    });
  });
});

describe('Boss chest lifecycle — atomic claim failure (retryable, no reward loss)', () => {
  it('reverts to available (not stranded) when the bag lacks capacity, and succeeds on retry', () => {
    const { world, playerEid, familyId } = setupFloor2World(16, 'boss-chest-it-capfail');
    killBossFamily(world, familyId);
    const chestId = createBossChestId(familyId);
    const bundleKeysBefore = [...world.generatedEquipmentRewardBundles.get(chestId)!.instanceKeys];

    const bag = world.inventories.get(playerEid)!;
    world.inventories.set(playerEid, { ...bag, generatedEquipmentCapacity: 0 });

    const failedOpen = openBossChest(world, chestId, playerEid);
    expect(failedOpen).toMatchObject({ ok: false, reason: 'grantFailed' });
    // Reverted to 'available', not stranded in 'opening'.
    expect(world.bossChests.get(chestId)!.state).toBe('available');
    // Bundle retained (claim stays retryable) and nothing leaked into the bag.
    expect(world.generatedEquipmentRewardBundles.has(chestId)).toBe(true);
    const bagAfterFail = world.inventories.get(playerEid)!;
    for (const key of bundleKeysBefore) {
      expect(hasGeneratedEquipmentReference(bagAfterFail, key)).toBe(false);
    }

    // Fix capacity and retry: succeeds without re-invoking the generator —
    // same instance keys as before the failed attempt.
    world.inventories.set(playerEid, { ...bagAfterFail, generatedEquipmentCapacity: 10 });
    const retryOpen = openBossChest(world, chestId, playerEid);
    expect(retryOpen).toMatchObject({ ok: true, alreadyClaimed: false, state: 'revealed' });
    const bagAfterRetry = world.inventories.get(playerEid)!;
    for (const key of bundleKeysBefore) {
      expect(hasGeneratedEquipmentReference(bagAfterRetry, key)).toBe(true);
    }
  });
});

describe('Boss chest lifecycle — Floor 1 exclusion', () => {
  it('never creates a boss chest on Floor 1, even with a real boss-death event and flags enabled', () => {
    const world = createTestWorld({
      seed: 17,
      floor: 1,
      generatedEquipmentRunKey: 'boss-chest-it-floor1',
    });
    enableFloor2Economy(world);
    spawnPlayer(world, 0, 0);

    const result = spawnBossChestForDefeatedBoss(world, 'mirekin');
    expect(result).toEqual({ created: false, reason: 'bossChestsDisabled' });
    expect(world.bossChests.size).toBe(0);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
  });
});

describe('Boss chest lifecycle — save/load carryover', () => {
  it('round-trips an available (unopened) chest and its live bundle without re-generating', () => {
    const source = setupFloor2World(18, 'boss-chest-it-carry-available');
    killBossFamily(source.world, source.familyId);
    const chestId = createBossChestId(source.familyId);
    const bundleKeys = [...source.world.generatedEquipmentRewardBundles.get(chestId)!.instanceKeys];
    const snapshot = capturePlayerCarryover(source.world, source.playerEid);

    const dest = createTestWorld({
      seed: 99,
      floor: 2,
      generatedEquipmentRunKey: 'boss-chest-it-carry-available',
    });
    enableFloor2Economy(dest);
    const destPlayer = spawnPlayer(dest, 0, 0);
    restorePlayerCarryover(dest, destPlayer, snapshot);

    const restoredChest = dest.bossChests.get(chestId);
    expect(restoredChest).toBeDefined();
    expect(restoredChest!.state).toBe('available');
    const restoredBundle = dest.generatedEquipmentRewardBundles.get(chestId);
    expect(restoredBundle).toBeDefined();
    expect([...restoredBundle!.instanceKeys]).toEqual(bundleKeys);
    expect(listGeneratedEquipmentInstances(dest).length).toBe(1);

    // The restored chest is openable on the destination world.
    const openResult = openBossChest(dest, chestId, destPlayer);
    expect(openResult).toMatchObject({ ok: true, alreadyClaimed: false, state: 'revealed' });
  });

  it('round-trips a revealed (opened, not yet acknowledged) chest with no lingering bundle', () => {
    const source = setupFloor2World(19, 'boss-chest-it-carry-revealed');
    killBossFamily(source.world, source.familyId);
    const chestId = createBossChestId(source.familyId);
    const openResult = openBossChest(source.world, chestId, source.playerEid);
    expect(openResult).toMatchObject({ ok: true, state: 'revealed' });
    expect(source.world.generatedEquipmentRewardBundles.has(chestId)).toBe(false);
    const snapshot = capturePlayerCarryover(source.world, source.playerEid);
    expect(snapshot.bossChests.some((chest) => chest.chestId === chestId)).toBe(true);
    expect(snapshot.generatedEquipmentRewardBundles).toHaveLength(0);

    const dest = createTestWorld({
      seed: 100,
      floor: 2,
      generatedEquipmentRunKey: 'boss-chest-it-carry-revealed',
    });
    enableFloor2Economy(dest);
    const destPlayer = spawnPlayer(dest, 0, 0);
    restorePlayerCarryover(dest, destPlayer, snapshot);

    expect(dest.bossChests.get(chestId)!.state).toBe('revealed');
    expect(dest.generatedEquipmentRewardBundles.has(chestId)).toBe(false);

    // Idempotent on the destination world too.
    const ack = acknowledgeBossChestReveal(dest, chestId);
    expect(ack).toEqual({ ok: true, alreadyClaimed: false });
  });

  it('round-trips a claimed chest with no lingering bundle', () => {
    const source = setupFloor2World(20, 'boss-chest-it-carry-claimed');
    killBossFamily(source.world, source.familyId);
    const chestId = createBossChestId(source.familyId);
    openBossChest(source.world, chestId, source.playerEid);
    acknowledgeBossChestReveal(source.world, chestId);
    const snapshot = capturePlayerCarryover(source.world, source.playerEid);

    const dest = createTestWorld({
      seed: 101,
      floor: 2,
      generatedEquipmentRunKey: 'boss-chest-it-carry-claimed',
    });
    enableFloor2Economy(dest);
    const destPlayer = spawnPlayer(dest, 0, 0);
    restorePlayerCarryover(dest, destPlayer, snapshot);

    expect(dest.bossChests.get(chestId)!.state).toBe('claimed');
    expect(dest.generatedEquipmentRewardBundles.has(chestId)).toBe(false);
    expect(acknowledgeBossChestReveal(dest, chestId)).toEqual({ ok: true, alreadyClaimed: true });
  });
});

describe('Boss chest lifecycle — malformed/stale carryover fails closed', () => {
  function baseSnapshotWithAvailableChest(): {
    dest: GameWorld;
    destPlayer: number;
    chestId: string;
    snapshot: ReturnType<typeof capturePlayerCarryover>;
  } {
    const source = setupFloor2World(21, 'boss-chest-it-malformed');
    killBossFamily(source.world, source.familyId);
    const chestId = createBossChestId(source.familyId);
    const snapshot = capturePlayerCarryover(source.world, source.playerEid);
    const dest = createTestWorld({
      seed: 22,
      floor: 2,
      generatedEquipmentRunKey: 'boss-chest-it-malformed',
    });
    enableFloor2Economy(dest);
    const destPlayer = spawnPlayer(dest, 0, 0);
    return { dest, destPlayer, chestId, snapshot };
  }

  it('rejects a chest persisted mid-transaction (state=opening)', () => {
    const { dest, destPlayer, chestId, snapshot } = baseSnapshotWithAvailableChest();
    const tampered = mutableClone(snapshot);
    const chest = tampered.bossChests.find((entry) => entry.chestId === chestId)!;
    chest.state = 'opening';
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /persisted mid-transaction/,
    );
  });

  it('rejects a chest whose id does not match its familyId', () => {
    const { dest, destPlayer, chestId, snapshot } = baseSnapshotWithAvailableChest();
    const tampered = mutableClone(snapshot);
    const chest = tampered.bossChests.find((entry) => entry.chestId === chestId)!;
    chest.familyId = 'some-other-family';
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /does not match family/,
    );
  });

  it('rejects duplicate boss chest entries', () => {
    const { dest, destPlayer, chestId, snapshot } = baseSnapshotWithAvailableChest();
    const tampered = mutableClone(snapshot);
    const chest = tampered.bossChests.find((entry) => entry.chestId === chestId)!;
    tampered.bossChests = [...tampered.bossChests, { ...chest }];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /Duplicate boss chest/,
    );
  });

  it('rejects an available chest missing its reward bundle (orphaned chest)', () => {
    const { dest, destPlayer, chestId, snapshot } = baseSnapshotWithAvailableChest();
    const tampered = mutableClone(snapshot);
    tampered.generatedEquipmentRewardBundles = tampered.generatedEquipmentRewardBundles.filter(
      (bundle) => bundle.achievementId !== chestId,
    );
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /is missing its reward bundle/,
    );
  });

  it('rejects a bundle persisted for an already-opened (revealed) boss chest (orphaned bundle)', () => {
    const { dest, destPlayer, chestId, snapshot } = baseSnapshotWithAvailableChest();
    const tampered = mutableClone(snapshot);
    const chest = tampered.bossChests.find((entry) => entry.chestId === chestId)!;
    // Mark the chest revealed while illegally leaving its bundle in place —
    // claimGeneratedEquipmentRewardBundle always deletes the bundle on a
    // successful grant, so a live bundle for a non-'available' chest is
    // corruption, not a legitimate save state.
    chest.state = 'revealed';
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /already-opened boss chest/,
    );
  });

  it('rejects an unknown boss chest lifecycle state', () => {
    const { dest, destPlayer, chestId, snapshot } = baseSnapshotWithAvailableChest();
    const tampered = mutableClone(snapshot);
    const chest = tampered.bossChests.find((entry) => entry.chestId === chestId)!;
    (chest as { state: string }).state = 'exploded';
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /Unknown boss chest state/,
    );
  });
});
