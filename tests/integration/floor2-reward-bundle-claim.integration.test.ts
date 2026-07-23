import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { asFamilyId, asResourceId } from '../../src/core/faction-relations.js';
import {
  achievementSystem,
  claimAchievementReward,
  isAchievementClaimed,
  unlockAchievement,
} from '../../src/game/systems/achievementSystem.js';
import { capturePlayerCarryover, restorePlayerCarryover } from '../../src/game/playerCarryover.js';
import { listGeneratedEquipmentInstances } from '../../src/core/generated-equipment-registry.js';
import { hasGeneratedEquipmentReference } from '../../src/shared/inventory.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';

const ACHIEVEMENT_ID = 'floor2-field-kit';
const RUN_KEY = 'floor2-reward-bundles-it';

type DeepWriteable<T> = T extends object ? { -readonly [K in keyof T]: DeepWriteable<T[K]> } : T;

function mutableClone<T>(value: T): DeepWriteable<T> {
  return structuredClone(value) as DeepWriteable<T>;
}

function enableFloor2Rewards(world: GameWorld): void {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentRewards = true;
}

function makeFloor2World(runKey = RUN_KEY): { world: GameWorld; playerEid: number } {
  const world = createTestWorld({ seed: 42, floor: 2, generatedEquipmentRunKey: runKey });
  enableFloor2Rewards(world);
  const playerEid = spawnPlayer(world, 0, 0);
  return { world, playerEid };
}

/** Drive a Floor 2 trash kill so the real achievement tick sees totalKills >= 1. */
function seedFloor2Kill(world: GameWorld, kills = 1): void {
  world.floorId = 'floor2';
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [asFamilyId('mirekin')],
      contestedResource: asResourceId('glimmercap'),
      betrayerFlag: false,
      trashKillsByFamily: new Map([[asFamilyId('mirekin'), kills]]),
    },
  };
}

describe('Floor 2 reward bundle — real unlock/claim pipeline (observe real artifact)', () => {
  it('resolves a bundle at unlock through the real achievementSystem tick, then claims it exactly-once', () => {
    const { world, playerEid } = makeFloor2World();
    seedFloor2Kill(world);

    // REAL runtime entry point — the post-system pipeline calls achievementSystem.
    achievementSystem(world);

    expect(world.achievements.unlockedIds.has(ACHIEVEMENT_ID)).toBe(true);
    const bundle = world.generatedEquipmentRewardBundles.get(ACHIEVEMENT_ID);
    expect(bundle).toBeDefined();
    expect(bundle!.instanceKeys).toHaveLength(3);
    const instanceCountAfterUnlock = listGeneratedEquipmentInstances(world).length;
    expect(instanceCountAfterUnlock).toBe(3);
    const bundleKeys = [...bundle!.instanceKeys];

    // Claim transfers the bundle to the player's bag WITHOUT invoking the
    // generator (instance count is unchanged; the exact pre-claim keys land in
    // the bag; the bundle is consumed).
    const result = claimAchievementReward(world, ACHIEVEMENT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grantedEquipment).toHaveLength(3);
    expect(listGeneratedEquipmentInstances(world).length).toBe(instanceCountAfterUnlock);
    expect(world.generatedEquipmentRewardBundles.has(ACHIEVEMENT_ID)).toBe(false);
    const bag = world.inventories.get(playerEid)!;
    for (const key of bundleKeys) {
      expect(hasGeneratedEquipmentReference(bag, key)).toBe(true);
    }
    expect(isAchievementClaimed(world, ACHIEVEMENT_ID)).toBe(true);

    // Idempotent / exact-once: a second claim does nothing.
    const second = claimAchievementReward(world, ACHIEVEMENT_ID);
    expect(second).toEqual({ ok: false, reason: 'alreadyClaimed' });
    for (const key of bundleKeys) {
      expect(hasGeneratedEquipmentReference(bag, key)).toBe(true);
    }
  });

  it('claim fails closed (no claim, no bundle loss) when the player has no bag', () => {
    const world = createTestWorld({ seed: 42, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    enableFloor2Rewards(world);
    // No player spawned → no bag → grant cannot complete.
    expect(unlockAchievement(world, ACHIEVEMENT_ID)).toBe(true);
    const result = claimAchievementReward(world, ACHIEVEMENT_ID);
    expect(result).toEqual({ ok: false, reason: 'grantFailed' });
    expect(isAchievementClaimed(world, ACHIEVEMENT_ID)).toBe(false);
    // Bundle is retained so the claim stays retryable.
    expect(world.generatedEquipmentRewardBundles.has(ACHIEVEMENT_ID)).toBe(true);
  });
});

describe('Floor 2 reward bundle — Floor 1 exclusion / equipment-free preservation', () => {
  it('does not resolve or unlock an equipment reward on Floor 1', () => {
    const world = createTestWorld({ seed: 42, floor: 1, generatedEquipmentRunKey: RUN_KEY });
    // Even if the flags were somehow set, the floor gate keeps Floor 1 equipment-free.
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    world.floor2EquipmentFlags.floor2EquipmentRewards = true;
    spawnPlayer(world, 0, 0);

    expect(unlockAchievement(world, ACHIEVEMENT_ID)).toBe(false);
    expect(world.achievements.unlockedIds.has(ACHIEVEMENT_ID)).toBe(false);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
  });

  it('does not resolve when the rewards flag is disabled on Floor 2', () => {
    const world = createTestWorld({ seed: 42, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    // floor2EquipmentRewards stays false.
    spawnPlayer(world, 0, 0);

    expect(unlockAchievement(world, ACHIEVEMENT_ID)).toBe(false);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
  });
});

describe('Floor 2 reward bundle — save/load carryover', () => {
  it('round-trips an unclaimed bundle without re-generating (load never invokes the generator)', () => {
    const source = makeFloor2World('carry-run');
    expect(unlockAchievement(source.world, ACHIEVEMENT_ID)).toBe(true);
    const bundleKeys = [
      ...source.world.generatedEquipmentRewardBundles.get(ACHIEVEMENT_ID)!.instanceKeys,
    ];
    const snapshot = capturePlayerCarryover(source.world, source.playerEid);

    const dest = createTestWorld({ seed: 99, floor: 2, generatedEquipmentRunKey: 'carry-run' });
    enableFloor2Rewards(dest);
    const destPlayer = spawnPlayer(dest, 0, 0);
    restorePlayerCarryover(dest, destPlayer, snapshot);

    const restored = dest.generatedEquipmentRewardBundles.get(ACHIEVEMENT_ID);
    expect(restored).toBeDefined();
    expect([...restored!.instanceKeys]).toEqual(bundleKeys);
    // Registry restored from the snapshot, not re-generated.
    expect(listGeneratedEquipmentInstances(dest).length).toBe(3);
    expect(dest.achievements.unlockedIds.has(ACHIEVEMENT_ID)).toBe(true);

    // The restored bundle is claimable on the destination world.
    const result = claimAchievementReward(dest, ACHIEVEMENT_ID);
    expect(result.ok).toBe(true);
  });

  it('a claimed achievement carries over with no lingering bundle', () => {
    const source = makeFloor2World('carry-claimed');
    expect(unlockAchievement(source.world, ACHIEVEMENT_ID)).toBe(true);
    expect(claimAchievementReward(source.world, ACHIEVEMENT_ID).ok).toBe(true);
    const snapshot = capturePlayerCarryover(source.world, source.playerEid);
    expect(snapshot.generatedEquipmentRewardBundles).toHaveLength(0);

    const dest = createTestWorld({ seed: 1, floor: 2, generatedEquipmentRunKey: 'carry-claimed' });
    enableFloor2Rewards(dest);
    const destPlayer = spawnPlayer(dest, 0, 0);
    restorePlayerCarryover(dest, destPlayer, snapshot);

    expect(dest.generatedEquipmentRewardBundles.has(ACHIEVEMENT_ID)).toBe(false);
    expect(dest.achievements.claimedIds.has(ACHIEVEMENT_ID)).toBe(true);
  });
});

describe('Floor 2 reward bundle — stale/malformed carryover fails closed', () => {
  function baseSnapshotWithBundle(): {
    dest: GameWorld;
    destPlayer: number;
    snapshot: ReturnType<typeof capturePlayerCarryover>;
  } {
    const source = makeFloor2World('malformed');
    unlockAchievement(source.world, ACHIEVEMENT_ID);
    const snapshot = capturePlayerCarryover(source.world, source.playerEid);
    const dest = createTestWorld({ seed: 5, floor: 2, generatedEquipmentRunKey: 'malformed' });
    enableFloor2Rewards(dest);
    const destPlayer = spawnPlayer(dest, 0, 0);
    return { dest, destPlayer, snapshot };
  }

  it('rejects a bundle whose achievement is not unlocked', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    tampered.achievements.unlockedIds = tampered.achievements.unlockedIds.filter(
      (id) => id !== ACHIEVEMENT_ID,
    );
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/locked achievement/);
  });

  it('rejects a bundle whose achievement is already claimed', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    tampered.achievements.claimedIds = [...tampered.achievements.claimedIds, ACHIEVEMENT_ID];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/already-claimed/);
  });

  it('rejects a bundle for a non-equipment achievement', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    tampered.generatedEquipmentRewardBundles[0]!.achievementId = 'first-bonk';
    tampered.achievements.unlockedIds = [...tampered.achievements.unlockedIds, 'first-bonk'];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/non-equipment/);
  });

  it('rejects a bundle with a dangling instance key', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    // Keep the canonical 3-instance shape but point the last key at a
    // non-existent instance so the dangling-reference guard (not the length
    // guard) is what rejects it.
    const keys = [...tampered.generatedEquipmentRewardBundles[0]!.instanceKeys];
    keys[keys.length - 1] = 'gei:v1:malformed:9999';
    tampered.generatedEquipmentRewardBundles[0]!.instanceKeys = keys;
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/Dangling/);
  });

  it('rejects a bundle with the wrong instance count', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    tampered.generatedEquipmentRewardBundles[0]!.instanceKeys =
      tampered.generatedEquipmentRewardBundles[0]!.instanceKeys.slice(0, 2);
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/exactly 3 instances/);
  });

  it('rejects a bundle whose instances are out of canonical rarity order', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    tampered.generatedEquipmentRewardBundles[0]!.instanceKeys = [
      ...tampered.generatedEquipmentRewardBundles[0]!.instanceKeys,
    ].reverse();
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/expected common/);
  });

  it('rejects a bundle with an unsupported schema version', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    (tampered.generatedEquipmentRewardBundles[0] as { schemaVersion: string }).schemaVersion =
      'reward-bundle/v999';
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow();
  });
});

describe('Floor 2 reward bundle — malformed live bundle claim fails closed', () => {
  it('claim rejects a live bundle with the wrong instance count (no claim, no grant)', () => {
    const { world, playerEid } = makeFloor2World('claim-badlen');
    expect(unlockAchievement(world, ACHIEVEMENT_ID)).toBe(true);
    const bundle = world.generatedEquipmentRewardBundles.get(ACHIEVEMENT_ID)!;
    const firstKey = bundle.instanceKeys[0]!;
    world.generatedEquipmentRewardBundles.set(ACHIEVEMENT_ID, {
      ...bundle,
      instanceKeys: [firstKey],
    });
    const result = claimAchievementReward(world, ACHIEVEMENT_ID);
    expect(result.ok).toBe(false);
    expect(isAchievementClaimed(world, ACHIEVEMENT_ID)).toBe(false);
    // Bundle retained (retryable) and nothing leaked into the bag.
    expect(world.generatedEquipmentRewardBundles.has(ACHIEVEMENT_ID)).toBe(true);
    const bag = world.inventories.get(playerEid)!;
    expect(hasGeneratedEquipmentReference(bag, firstKey)).toBe(false);
  });

  it('claim rejects a live bundle whose instances are out of canonical rarity order', () => {
    const { world, playerEid } = makeFloor2World('claim-badorder');
    expect(unlockAchievement(world, ACHIEVEMENT_ID)).toBe(true);
    const bundle = world.generatedEquipmentRewardBundles.get(ACHIEVEMENT_ID)!;
    world.generatedEquipmentRewardBundles.set(ACHIEVEMENT_ID, {
      ...bundle,
      instanceKeys: [...bundle.instanceKeys].reverse(),
    });
    const result = claimAchievementReward(world, ACHIEVEMENT_ID);
    expect(result.ok).toBe(false);
    expect(isAchievementClaimed(world, ACHIEVEMENT_ID)).toBe(false);
    expect(world.generatedEquipmentRewardBundles.has(ACHIEVEMENT_ID)).toBe(true);
    const bag = world.inventories.get(playerEid)!;
    for (const key of bundle.instanceKeys) {
      expect(hasGeneratedEquipmentReference(bag, key)).toBe(false);
    }
  });
});
