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
import {
  createGeneratedEquipmentInstance,
  listGeneratedEquipmentInstances,
} from '../../src/core/generated-equipment-registry.js';
import { getItemCount, hasGeneratedEquipmentReference } from '../../src/shared/inventory.js';
import {
  FLOOR1_COMMON_CRAFTING_MATERIALS,
  LEGACY_TIER4_ACHIEVEMENT_BUNDLE_IDS,
  LOOT_BOX_GOLD_BY_TIER,
  LOOT_BOX_MATERIAL_COUNT_BY_TIER,
} from '../../src/shared/achievements.js';
import { GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION } from '../../src/shared/generated-equipment-types.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { generatedEquipmentInput } from '../fixtures/generated-equipment.js';

// Floor 2 achievements — all single-instance equipment bundles, tiered.
const TIER1_ACHIEVEMENT_ID = 'floor2-field-kit';
const TIER3_ACHIEVEMENT_ID = 'floor2-veteran-cast';
const RUN_KEY = 'floor2-reward-bundles-it';
// Floor 1 achievement — real lootBox reward (gold + materials, tier "trash").
const FLOOR1_LOOT_BOX_ACHIEVEMENT_ID = 'first-bonk';

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

/**
 * Drive a Floor 2 trash kill so the real achievement tick sees totalKills >= 1.
 *
 * Uses a realistic 3-family roster (real Floor 2 always presents 3 or 4 families,
 * fixed for the whole floor via `selectFloor2Roster` — see floor2Scenario.ts). A
 * single-family roster is not a reachable production state and would trivially
 * satisfy "all present families engaged in combat"-style facts, unlocking
 * unrelated achievements (e.g. floor2-scorched-earth) alongside floor2-field-kit
 * and floor2-made-an-enemy, breaking this test's deterministic two-unlock assumption.
 */
function seedFloor2Kill(world: GameWorld, kills = 1): void {
  world.floorId = 'floor2';
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [asFamilyId('mirekin'), asFamilyId('chitinous'), asFamilyId('faceless')],
      contestedResource: asResourceId('glimmercap'),
      betrayerFlag: false,
      trashKillsByFamily: new Map([[asFamilyId('mirekin'), kills]]),
    },
  };
}

describe('Floor 2 reward bundle — real unlock/claim pipeline (observe real artifact)', () => {
  it('resolves a single-instance tier1 bundle at unlock through the real achievementSystem tick, then claims it exactly-once', () => {
    const { world, playerEid } = makeFloor2World();
    seedFloor2Kill(world);

    // REAL runtime entry point — the post-system pipeline calls achievementSystem.
    achievementSystem(world);

    expect(world.achievements.unlockedIds.has(TIER1_ACHIEVEMENT_ID)).toBe(true);
    const bundle = world.generatedEquipmentRewardBundles.get(TIER1_ACHIEVEMENT_ID);
    expect(bundle).toBeDefined();
    expect(bundle!.tier).toBe('tier1');
    expect(bundle!.instanceKeys).toHaveLength(1);
    const instanceCountAfterUnlock = listGeneratedEquipmentInstances(world).length;
    // Only one equipment-granting achievement fires with the first kill:
    // floor2-field-kit (totalKills >= 1). floor2-made-an-enemy also unlocks
    // (familiesEngagedInCombatCount >= 1) but now pays out the
    // `floor1-materials` table, so it generates no equipment instance.
    expect(instanceCountAfterUnlock).toBe(1);
    const bundleKeys = [...bundle!.instanceKeys];

    // Claim transfers the bundle to the player's bag WITHOUT invoking the
    // generator (instance count is unchanged; the exact pre-claim key lands in
    // the bag; the bundle is consumed).
    const result = claimAchievementReward(world, TIER1_ACHIEVEMENT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grantedEquipment).toHaveLength(1);
    expect(listGeneratedEquipmentInstances(world).length).toBe(instanceCountAfterUnlock);
    expect(world.generatedEquipmentRewardBundles.has(TIER1_ACHIEVEMENT_ID)).toBe(false);
    const bag = world.inventories.get(playerEid)!;
    for (const key of bundleKeys) {
      expect(hasGeneratedEquipmentReference(bag, key)).toBe(true);
    }
    expect(isAchievementClaimed(world, TIER1_ACHIEVEMENT_ID)).toBe(true);

    // Idempotent / exact-once: a second claim does nothing.
    const second = claimAchievementReward(world, TIER1_ACHIEVEMENT_ID);
    expect(second).toEqual({ ok: false, reason: 'alreadyClaimed' });
    for (const key of bundleKeys) {
      expect(hasGeneratedEquipmentReference(bag, key)).toBe(true);
    }
  });

  it('claim fails closed (no claim, no bundle loss) when the player has no bag', () => {
    const world = createTestWorld({ seed: 42, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    enableFloor2Rewards(world);
    // No player spawned → no bag → grant cannot complete.
    expect(unlockAchievement(world, TIER1_ACHIEVEMENT_ID)).toBe(true);
    const result = claimAchievementReward(world, TIER1_ACHIEVEMENT_ID);
    expect(result).toEqual({ ok: false, reason: 'grantFailed' });
    expect(isAchievementClaimed(world, TIER1_ACHIEVEMENT_ID)).toBe(false);
    // Bundle is retained so the claim stays retryable.
    expect(world.generatedEquipmentRewardBundles.has(TIER1_ACHIEVEMENT_ID)).toBe(true);
  });

  it('claim fails closed (grantFailed) when the bag lacks capacity for the single item (atomic claim contract)', () => {
    const { world, playerEid } = makeFloor2World('cap-fail-run');
    expect(unlockAchievement(world, TIER1_ACHIEVEMENT_ID)).toBe(true);
    const bundle = world.generatedEquipmentRewardBundles.get(TIER1_ACHIEVEMENT_ID)!;
    const bundleKeys = [...bundle.instanceKeys];

    // Force the bag to have zero capacity for generated-equipment items so the
    // all-or-nothing validation fails before any mutation.
    const bag = world.inventories.get(playerEid)!;
    world.inventories.set(playerEid, { ...bag, generatedEquipmentCapacity: 0 });

    const result = claimAchievementReward(world, TIER1_ACHIEVEMENT_ID);
    expect(result).toEqual({ ok: false, reason: 'grantFailed' });

    // Achievement must remain unclaimed.
    expect(isAchievementClaimed(world, TIER1_ACHIEVEMENT_ID)).toBe(false);
    // Bundle must be retained (claim stays retryable).
    expect(world.generatedEquipmentRewardBundles.has(TIER1_ACHIEVEMENT_ID)).toBe(true);
    // No instance must have been transferred to the bag.
    const bagAfter = world.inventories.get(playerEid)!;
    for (const key of bundleKeys) {
      expect(hasGeneratedEquipmentReference(bagAfter, key)).toBe(false);
    }
  });
});

describe('Floor 1 lootBox reward — real unlock/claim pipeline (gold + common materials only)', () => {
  it('grants gold + common crafting materials on claim, never equipment, and claims exactly-once', () => {
    const world = createTestWorld({ seed: 7, floor: 1 });
    const playerEid = spawnPlayer(world, 0, 0);
    const goldBefore = world.playerGold;

    expect(unlockAchievement(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);

    const result = claimAchievementReward(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reward.type).toBe('lootBox');
    if (result.reward.type !== 'lootBox') return;
    const expectedGold = LOOT_BOX_GOLD_BY_TIER[result.reward.tier];
    const expectedMaterialCount = LOOT_BOX_MATERIAL_COUNT_BY_TIER[result.reward.tier];

    expect(result.grantedLootBox).toBeDefined();
    expect(result.grantedLootBox!.gold).toBe(expectedGold);
    expect(result.grantedLootBox!.materials).toHaveLength(expectedMaterialCount);
    for (const materialId of result.grantedLootBox!.materials) {
      expect(FLOOR1_COMMON_CRAFTING_MATERIALS).toContain(materialId);
    }

    // Real mutation observed on the real world state (gold + bag), never the
    // generated-equipment registry — Floor 1 boxes are structurally
    // equipment-free.
    expect(world.playerGold).toBe(goldBefore + expectedGold);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    const bag = world.inventories.get(playerEid)!;
    for (const materialId of result.grantedLootBox!.materials) {
      expect(getItemCount(bag, materialId)).toBeGreaterThan(0);
    }
    expect(isAchievementClaimed(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);

    // Idempotent / exact-once: a second claim grants nothing further.
    const second = claimAchievementReward(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    expect(second).toEqual({ ok: false, reason: 'alreadyClaimed' });
    expect(world.playerGold).toBe(goldBefore + expectedGold);
  });

  it('is deterministic: replaying the same world seed + achievement grants identical materials', () => {
    const worldA = createTestWorld({ seed: 123, floor: 1 });
    spawnPlayer(worldA, 0, 0);
    unlockAchievement(worldA, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    const resultA = claimAchievementReward(worldA, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);

    const worldB = createTestWorld({ seed: 123, floor: 1 });
    spawnPlayer(worldB, 0, 0);
    unlockAchievement(worldB, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    const resultB = claimAchievementReward(worldB, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;
    expect(resultB.grantedLootBox).toEqual(resultA.grantedLootBox);
  });

  it('claim fails closed (no partial grant) when the player has no bag', () => {
    const world = createTestWorld({ seed: 7, floor: 1 });
    // No player spawned → no bag → grant cannot complete.
    expect(unlockAchievement(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);
    const goldBefore = world.playerGold;
    const result = claimAchievementReward(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    expect(result).toEqual({ ok: false, reason: 'grantFailed' });
    expect(isAchievementClaimed(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(false);
    // No gold leaked despite the failed grant.
    expect(world.playerGold).toBe(goldBefore);
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

    expect(unlockAchievement(world, TIER1_ACHIEVEMENT_ID)).toBe(false);
    expect(world.achievements.unlockedIds.has(TIER1_ACHIEVEMENT_ID)).toBe(false);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
  });

  it('does not resolve when the rewards flag is disabled on Floor 2', () => {
    const world = createTestWorld({ seed: 42, floor: 2, generatedEquipmentRunKey: RUN_KEY });
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    // floor2EquipmentRewards stays false.
    spawnPlayer(world, 0, 0);

    expect(unlockAchievement(world, TIER1_ACHIEVEMENT_ID)).toBe(false);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
  });

  it('a Floor 1 lootBox achievement never touches the generated-equipment registry or reward-bundle map', () => {
    const world = createTestWorld({ seed: 42, floor: 1, generatedEquipmentRunKey: RUN_KEY });
    enableFloor2Rewards(world);
    spawnPlayer(world, 0, 0);

    expect(unlockAchievement(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);

    claimAchievementReward(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
  });
});

describe('Legacy tier4 achievement bundle — claim usability regression', () => {
  // These three achievements briefly resolved at tier4 before the tier model
  // tightened to tier1-tier3. Persisted tier4 bundles must claim successfully,
  // transferring the exact pre-resolved instance without re-rolling.
  it.each([...LEGACY_TIER4_ACHIEVEMENT_BUNDLE_IDS])(
    'claims a persisted tier4 bundle for legacy achievement %s, transfers the exact instance, consumes the bundle',
    (achievementId) => {
      const runKey = `legacy-tier4-claim-${achievementId}`;
      const world = createTestWorld({ seed: 42, floor: 2, generatedEquipmentRunKey: runKey });
      enableFloor2Rewards(world);
      const playerEid = spawnPlayer(world, 0, 0);

      // Inject a pre-existing tier4 bundle as if it was generated before the
      // tier model migration, using a 'rare' rarity (within tier4's allowed pool).
      const instance = createGeneratedEquipmentInstance(
        world,
        generatedEquipmentInput({ baseId: 'weapon.iron-cleaver', rarity: 'rare' }),
      );
      const instanceKey = instance.instanceId;
      world.achievements.unlockedIds.add(achievementId);
      world.generatedEquipmentRewardBundles.set(achievementId, {
        schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
        achievementId,
        tier: 'tier4',
        instanceKeys: [instanceKey],
      });

      const instanceCountBefore = listGeneratedEquipmentInstances(world).length;

      const result = claimAchievementReward(world, achievementId);

      // Claim must succeed.
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Exactly the pre-generated instance is transferred — no re-roll.
      expect(result.grantedEquipment).toHaveLength(1);
      expect(result.grantedEquipment![0]!.instanceKey).toBe(instanceKey);

      // Instance count unchanged (ownership transferred, not duplicated).
      expect(listGeneratedEquipmentInstances(world).length).toBe(instanceCountBefore);

      // Instance now in the player's bag.
      const bag = world.inventories.get(playerEid)!;
      expect(hasGeneratedEquipmentReference(bag, instanceKey)).toBe(true);

      // Bundle consumed.
      expect(world.generatedEquipmentRewardBundles.has(achievementId)).toBe(false);

      // Achievement marked claimed.
      expect(isAchievementClaimed(world, achievementId)).toBe(true);

      // Idempotent: second claim returns alreadyClaimed, bag unchanged.
      const second = claimAchievementReward(world, achievementId);
      expect(second).toEqual({ ok: false, reason: 'alreadyClaimed' });
      expect(hasGeneratedEquipmentReference(bag, instanceKey)).toBe(true);
    },
  );

  it('a tier4 bundle on an achievement outside the legacy allowlist fails closed (grantFailed), bundle retained', () => {
    const runKey = 'legacy-tier4-nonallowlisted-claim';
    const world = createTestWorld({ seed: 42, floor: 2, generatedEquipmentRunKey: runKey });
    enableFloor2Rewards(world);
    spawnPlayer(world, 0, 0);

    // floor2-field-kit is a tier1 achievement — NOT in the legacy tier4 allowlist.
    const achievementId = TIER1_ACHIEVEMENT_ID;
    const instance = createGeneratedEquipmentInstance(
      world,
      generatedEquipmentInput({ baseId: 'weapon.iron-cleaver', rarity: 'rare' }),
    );
    const instanceKey = instance.instanceId;
    world.achievements.unlockedIds.add(achievementId);
    world.generatedEquipmentRewardBundles.set(achievementId, {
      schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
      achievementId,
      tier: 'tier4',
      instanceKeys: [instanceKey],
    });

    const result = claimAchievementReward(world, achievementId);

    // Must fail closed — the tier4 mismatch is not in the allowlist.
    expect(result).toEqual({ ok: false, reason: 'grantFailed' });

    // Achievement must remain unclaimed.
    expect(isAchievementClaimed(world, achievementId)).toBe(false);

    // Bundle must be retained so the claim stays retryable.
    expect(world.generatedEquipmentRewardBundles.has(achievementId)).toBe(true);
  });
});

describe('Floor 2 reward bundle — save/load carryover', () => {
  it('round-trips an unclaimed tier1 bundle without re-generating (load never invokes the generator)', () => {
    const source = makeFloor2World('carry-run');
    expect(unlockAchievement(source.world, TIER1_ACHIEVEMENT_ID)).toBe(true);
    const bundleKeys = [
      ...source.world.generatedEquipmentRewardBundles.get(TIER1_ACHIEVEMENT_ID)!.instanceKeys,
    ];
    const snapshot = capturePlayerCarryover(source.world, source.playerEid);

    const dest = createTestWorld({ seed: 99, floor: 2, generatedEquipmentRunKey: 'carry-run' });
    enableFloor2Rewards(dest);
    const destPlayer = spawnPlayer(dest, 0, 0);
    restorePlayerCarryover(dest, destPlayer, snapshot);

    const restored = dest.generatedEquipmentRewardBundles.get(TIER1_ACHIEVEMENT_ID);
    expect(restored).toBeDefined();
    expect(restored!.tier).toBe('tier1');
    expect([...restored!.instanceKeys]).toEqual(bundleKeys);
    // Registry restored from the snapshot, not re-generated.
    expect(listGeneratedEquipmentInstances(dest).length).toBe(1);
    expect(dest.achievements.unlockedIds.has(TIER1_ACHIEVEMENT_ID)).toBe(true);

    // The restored bundle is claimable on the destination world.
    const result = claimAchievementReward(dest, TIER1_ACHIEVEMENT_ID);
    expect(result.ok).toBe(true);
  });

  it('a claimed achievement carries over with no lingering bundle', () => {
    const source = makeFloor2World('carry-claimed');
    expect(unlockAchievement(source.world, TIER1_ACHIEVEMENT_ID)).toBe(true);
    expect(claimAchievementReward(source.world, TIER1_ACHIEVEMENT_ID).ok).toBe(true);
    const snapshot = capturePlayerCarryover(source.world, source.playerEid);
    expect(snapshot.generatedEquipmentRewardBundles).toHaveLength(0);

    const dest = createTestWorld({ seed: 1, floor: 2, generatedEquipmentRunKey: 'carry-claimed' });
    enableFloor2Rewards(dest);
    const destPlayer = spawnPlayer(dest, 0, 0);
    restorePlayerCarryover(dest, destPlayer, snapshot);

    expect(dest.generatedEquipmentRewardBundles.has(TIER1_ACHIEVEMENT_ID)).toBe(false);
    expect(dest.achievements.claimedIds.has(TIER1_ACHIEVEMENT_ID)).toBe(true);
  });
});

describe('Floor 2 reward bundle — stale/malformed carryover fails closed', () => {
  function baseSnapshotWithBundle(): {
    dest: GameWorld;
    destPlayer: number;
    snapshot: ReturnType<typeof capturePlayerCarryover>;
  } {
    const source = makeFloor2World('malformed');
    unlockAchievement(source.world, TIER1_ACHIEVEMENT_ID);
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
      (id) => id !== TIER1_ACHIEVEMENT_ID,
    );
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/locked achievement/);
  });

  it('rejects a bundle whose achievement is already claimed', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    tampered.achievements.claimedIds = [...tampered.achievements.claimedIds, TIER1_ACHIEVEMENT_ID];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/already-claimed/);
  });

  it('rejects a bundle for a non-equipment achievement', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    tampered.generatedEquipmentRewardBundles[0]!.achievementId = 'first-bonk';
    tampered.achievements.unlockedIds = [...tampered.achievements.unlockedIds, 'first-bonk'];
    // Re-pointing the bundle away from TIER1_ACHIEVEMENT_ID leaves it
    // bundle-less; mark it (and 'first-bonk', a lootBox-reward achievement
    // with no lootBox bundle in this snapshot) claimed too, so neither
    // reverse missing-bundle guard fires first and masks the non-equipment
    // guard this test targets.
    tampered.achievements.claimedIds = [
      ...tampered.achievements.claimedIds,
      TIER1_ACHIEVEMENT_ID,
      'first-bonk',
    ];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/non-equipment/);
  });

  it('rejects a bundle with a dangling instance key', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    // Point the (only) instance key at a non-existent instance so the
    // dangling-reference guard (not the length guard) is what rejects it.
    tampered.generatedEquipmentRewardBundles[0]!.instanceKeys = ['gei:v1:malformed:9999'];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/Dangling/);
  });

  it('rejects a bundle with the wrong instance count', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    // A resolved tiered bundle always holds exactly 1 instance; an empty
    // instanceKeys array must be rejected rather than silently restored as an
    // empty/no-op reward.
    tampered.generatedEquipmentRewardBundles[0]!.instanceKeys = [];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /must contain exactly 1 instance/,
    );
  });

  it("rejects a bundle whose instance rarity is outside its tier's allowed pool", () => {
    // floor2-field-kit is tier1 (allowed rarities: [common] only). Build a
    // real tier3 bundle in the SAME run (whose pool is [uncommon, common]) at
    // a run key known to draw 'uncommon', then splice that instance key into
    // the tier1 bundle so it points at a real, non-dangling instance whose
    // rarity is outside tier1's pool.
    const source = makeFloor2World('rarity-probe-0');
    expect(unlockAchievement(source.world, TIER1_ACHIEVEMENT_ID)).toBe(true);
    expect(unlockAchievement(source.world, TIER3_ACHIEVEMENT_ID)).toBe(true);
    const uncommonKey = [
      ...source.world.generatedEquipmentRewardBundles.get(TIER3_ACHIEVEMENT_ID)!.instanceKeys,
    ][0]!;
    const snapshot = capturePlayerCarryover(source.world, source.playerEid);

    const dest = createTestWorld({ seed: 5, floor: 2, generatedEquipmentRunKey: 'rarity-probe-0' });
    enableFloor2Rewards(dest);
    const destPlayer = spawnPlayer(dest, 0, 0);

    const tampered = mutableClone(snapshot);
    const tier1Bundle = tampered.generatedEquipmentRewardBundles.find(
      (b) => b.achievementId === TIER1_ACHIEVEMENT_ID,
    )!;
    tier1Bundle.instanceKeys = [uncommonKey];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /instance has rarity uncommon, expected one of \[common\] for tier tier1/,
    );
  });

  it("rejects a bundle whose persisted tier does not match the achievement's defined tier", () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    (tampered.generatedEquipmentRewardBundles[0] as { tier: string }).tier = 'tier2';
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /tier tier2 does not match achievement tier tier1/,
    );
  });

  it('rejects a bundle with an unsupported schema version', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    (tampered.generatedEquipmentRewardBundles[0] as { schemaVersion: string }).schemaVersion =
      'reward-bundle/v999';
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow();
  });

  it('rejects a snapshot missing the bundle for an unlocked, unclaimed equipment achievement', () => {
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    // Strip the bundle out entirely — the achievement stays unlocked and
    // unclaimed, but has no way to ever be claimed under this snapshot.
    tampered.generatedEquipmentRewardBundles = [];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /Missing generated equipment reward bundle for unlocked, unclaimed achievement/,
    );
  });

  it('rejects a snapshot missing the bundle AND the registry for an unlocked, unclaimed equipment achievement', () => {
    // Regression test for the early-return bypass found in round-2
    // confirmation review: stripping the registry snapshot (not just the
    // bundle array) used to take validateGeneratedCarryover's early-return
    // path, skipping the reverse-presence guard entirely and letting the
    // tampered snapshot restore "successfully".
    const { dest, destPlayer, snapshot } = baseSnapshotWithBundle();
    const tampered = mutableClone(snapshot);
    tampered.generatedEquipmentRewardBundles = [];
    tampered.generatedInventoryInstanceKeys = [];
    tampered.generatedEquippedInstanceKeys = [];
    tampered.generatedEquipmentRegistry = undefined;
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /Missing generated equipment reward bundle for unlocked, unclaimed achievement/,
    );
  });
});

describe('Floor 2 reward bundle — malformed live bundle claim fails closed', () => {
  it('claim rejects a live bundle with the wrong instance count (no claim, no grant)', () => {
    const { world, playerEid } = makeFloor2World('claim-badlen');
    expect(unlockAchievement(world, TIER1_ACHIEVEMENT_ID)).toBe(true);
    const bundle = world.generatedEquipmentRewardBundles.get(TIER1_ACHIEVEMENT_ID)!;
    world.generatedEquipmentRewardBundles.set(TIER1_ACHIEVEMENT_ID, {
      ...bundle,
      instanceKeys: [],
    });
    const result = claimAchievementReward(world, TIER1_ACHIEVEMENT_ID);
    expect(result.ok).toBe(false);
    expect(isAchievementClaimed(world, TIER1_ACHIEVEMENT_ID)).toBe(false);
    // Bundle retained (retryable) and nothing leaked into the bag.
    expect(world.generatedEquipmentRewardBundles.has(TIER1_ACHIEVEMENT_ID)).toBe(true);
    const bag = world.inventories.get(playerEid)!;
    for (const key of bundle.instanceKeys) {
      expect(hasGeneratedEquipmentReference(bag, key)).toBe(false);
    }
  });

  it('claim rejects a live bundle whose instance rarity is outside the tier pool', () => {
    const { world, playerEid } = makeFloor2World('rarity-probe-0');
    expect(unlockAchievement(world, TIER1_ACHIEVEMENT_ID)).toBe(true);
    expect(unlockAchievement(world, TIER3_ACHIEVEMENT_ID)).toBe(true);
    const tier1Bundle = world.generatedEquipmentRewardBundles.get(TIER1_ACHIEVEMENT_ID)!;
    const tier3Bundle = world.generatedEquipmentRewardBundles.get(TIER3_ACHIEVEMENT_ID)!;
    // tier3 in this run key resolves to an 'uncommon' instance — outside
    // tier1's [common]-only pool.
    world.generatedEquipmentRewardBundles.set(TIER1_ACHIEVEMENT_ID, {
      ...tier1Bundle,
      instanceKeys: [...tier3Bundle.instanceKeys],
    });
    const result = claimAchievementReward(world, TIER1_ACHIEVEMENT_ID);
    expect(result.ok).toBe(false);
    expect(isAchievementClaimed(world, TIER1_ACHIEVEMENT_ID)).toBe(false);
    expect(world.generatedEquipmentRewardBundles.has(TIER1_ACHIEVEMENT_ID)).toBe(true);
    const bag = world.inventories.get(playerEid)!;
    for (const key of tier3Bundle.instanceKeys) {
      expect(hasGeneratedEquipmentReference(bag, key)).toBe(false);
    }
  });
});

describe('Floor 1 lootBox reward — malformed live bundle claim fails closed', () => {
  it('claim rejects a live bundle with a forged (non-canonical) gold amount', () => {
    const world = createTestWorld({ seed: 7, floor: 1 });
    const playerEid = spawnPlayer(world, 0, 0);
    const goldBefore = world.playerGold;
    expect(unlockAchievement(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);
    const bundle = world.lootBoxRewardBundles.get(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)!;
    world.lootBoxRewardBundles.set(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID, {
      ...bundle,
      gold: 999_999,
    });
    const result = claimAchievementReward(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    expect(result).toEqual({ ok: false, reason: 'grantFailed' });
    expect(isAchievementClaimed(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(false);
    // Bundle retained (retryable) and no gold leaked.
    expect(world.lootBoxRewardBundles.has(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);
    expect(world.playerGold).toBe(goldBefore);
    const bag = world.inventories.get(playerEid)!;
    for (const materialId of bundle.materials) {
      expect(getItemCount(bag, materialId)).toBe(0);
    }
  });

  it('claim rejects a live bundle with a forged (non-canonical) material count', () => {
    const world = createTestWorld({ seed: 7, floor: 1 });
    spawnPlayer(world, 0, 0);
    const goldBefore = world.playerGold;
    expect(unlockAchievement(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);
    const bundle = world.lootBoxRewardBundles.get(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)!;
    const [material] = FLOOR1_COMMON_CRAFTING_MATERIALS;
    world.lootBoxRewardBundles.set(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID, {
      ...bundle,
      materials: Array.from({ length: 1000 }, () => material!),
    });
    const result = claimAchievementReward(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    expect(result).toEqual({ ok: false, reason: 'grantFailed' });
    expect(isAchievementClaimed(world, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(false);
    expect(world.lootBoxRewardBundles.has(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);
    expect(world.playerGold).toBe(goldBefore);
  });
});

describe('Floor 1 lootBox reward bundle — save/load carryover', () => {
  it('round-trips an unclaimed lootBox bundle without re-resolving (load never invokes the resolver)', () => {
    const source = createTestWorld({
      seed: 7,
      floor: 1,
      generatedEquipmentRunKey: 'lootbox-carry',
    });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    expect(unlockAchievement(source, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);
    const resolved = source.lootBoxRewardBundles.get(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)!;
    expect(resolved).toBeDefined();
    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    expect(snapshot.lootBoxRewardBundles).toHaveLength(1);

    const dest = createTestWorld({
      seed: 999,
      floor: 1,
      generatedEquipmentRunKey: 'lootbox-carry',
    });
    const destPlayer = spawnPlayer(dest, 0, 0);
    restorePlayerCarryover(dest, destPlayer, snapshot);

    const restored = dest.lootBoxRewardBundles.get(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    expect(restored).toBeDefined();
    // Restored verbatim from the snapshot (a different seed/world would have
    // resolved different content had the resolver re-run) — proves load
    // never re-invokes the resolver.
    expect(restored).toEqual(resolved);
    expect(dest.achievements.unlockedIds.has(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);

    // The restored bundle is claimable on the destination world.
    const result = claimAchievementReward(dest, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    expect(result.ok).toBe(true);
  });

  it('a claimed lootBox achievement carries over with no lingering bundle', () => {
    const source = createTestWorld({
      seed: 7,
      floor: 1,
      generatedEquipmentRunKey: 'lootbox-carry-claimed',
    });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    expect(unlockAchievement(source, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);
    expect(claimAchievementReward(source, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID).ok).toBe(true);
    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    expect(snapshot.lootBoxRewardBundles).toHaveLength(0);

    const dest = createTestWorld({
      seed: 999,
      floor: 1,
      generatedEquipmentRunKey: 'lootbox-carry-claimed',
    });
    const destPlayer = spawnPlayer(dest, 0, 0);
    restorePlayerCarryover(dest, destPlayer, snapshot);

    expect(dest.lootBoxRewardBundles.has(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(false);
    expect(dest.achievements.claimedIds.has(FLOOR1_LOOT_BOX_ACHIEVEMENT_ID)).toBe(true);
  });
});

describe('Floor 1 lootBox reward bundle — stale/malformed carryover fails closed', () => {
  function baseLootBoxSnapshot(): {
    dest: GameWorld;
    destPlayer: number;
    snapshot: ReturnType<typeof capturePlayerCarryover>;
  } {
    const lootWorld = createTestWorld({ seed: 7, floor: 1 });
    const lootPlayer = spawnPlayer(lootWorld, 0, 0);
    unlockAchievement(lootWorld, FLOOR1_LOOT_BOX_ACHIEVEMENT_ID);
    const snapshot = capturePlayerCarryover(lootWorld, lootPlayer);
    const dest = createTestWorld({ seed: 5, floor: 1 });
    const destPlayer = spawnPlayer(dest, 0, 0);
    return { dest, destPlayer, snapshot };
  }

  it('rejects a lootBox bundle whose achievement is not unlocked', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    tampered.achievements.unlockedIds = tampered.achievements.unlockedIds.filter(
      (id) => id !== FLOOR1_LOOT_BOX_ACHIEVEMENT_ID,
    );
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/locked achievement/);
  });

  it('rejects a lootBox bundle whose achievement is already claimed', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    tampered.achievements.claimedIds = [
      ...tampered.achievements.claimedIds,
      FLOOR1_LOOT_BOX_ACHIEVEMENT_ID,
    ];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/already-claimed/);
  });

  it('rejects a lootBox bundle for a non-floor1-materials (Floor 2 generated-equipment) achievement', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    // Re-point the bundle at a real `lootBox` achievement that uses the Floor
    // 2 `floor2-generated-equipment` table rather than `floor1-materials` —
    // this is the discriminator-aware failure mode now that both Floor 1 and
    // Floor 2 rewards share the `lootBox` reward type.
    tampered.lootBoxRewardBundles[0]!.achievementId = TIER1_ACHIEVEMENT_ID;
    tampered.achievements.unlockedIds = [
      ...tampered.achievements.unlockedIds,
      TIER1_ACHIEVEMENT_ID,
    ];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /non-floor1-materials/,
    );
  });

  it('rejects a lootBox bundle for a genuinely non-lootBox achievement', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    // `safe-room-breather` is a real Floor 1 achievement with a
    // `directorMessage` reward (no lootBox at all) — the true "wrong reward
    // type entirely" case, distinct from the "wrong lootTable" case above.
    const NON_LOOT_BOX_ACHIEVEMENT_ID = 'safe-room-breather';
    tampered.lootBoxRewardBundles[0]!.achievementId = NON_LOOT_BOX_ACHIEVEMENT_ID;
    tampered.achievements.unlockedIds = [
      ...tampered.achievements.unlockedIds,
      NON_LOOT_BOX_ACHIEVEMENT_ID,
    ];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/non-lootBox/);
  });

  it('rejects a lootBox bundle with an invalid/missing tier', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    (tampered.lootBoxRewardBundles[0] as { tier: string }).tier = 'super-rare';
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /invalid or missing tier/,
    );
  });

  it("rejects a lootBox bundle whose persisted tier does not match the achievement's defined tier", () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    const actualTier = tampered.lootBoxRewardBundles[0]!.tier;
    const otherTier = actualTier === 'trash' ? 'common' : 'trash';
    (tampered.lootBoxRewardBundles[0] as { tier: string }).tier = otherTier;
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /does not match achievement tier/,
    );
  });

  it('rejects a lootBox bundle with a negative gold amount', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    tampered.lootBoxRewardBundles[0]!.gold = -1;
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(/invalid gold amount/);
  });

  it('rejects a lootBox bundle with a material id outside the Floor 1 common-crafting-material pool', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    tampered.lootBoxRewardBundles[0]!.materials = ['floor2-field-kit'];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /invalid material item id/,
    );
  });

  it('rejects a duplicate lootBox bundle for the same achievement', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    tampered.lootBoxRewardBundles = [
      tampered.lootBoxRewardBundles[0]!,
      { ...tampered.lootBoxRewardBundles[0]! },
    ];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /Duplicate loot box reward bundle/,
    );
  });

  it('rejects a lootBox bundle with an unsupported schema version', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    (tampered.lootBoxRewardBundles[0] as { schemaVersion: string }).schemaVersion =
      'loot-box-reward-bundle/v999';
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow();
  });

  it('rejects a lootBox bundle with forged (non-canonical) gold for its tier', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    tampered.lootBoxRewardBundles[0]!.gold = 999_999;
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /expected .* for tier/,
    );
  });

  it('rejects a lootBox bundle with a forged (non-canonical) material count for its tier', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    const tier = tampered.lootBoxRewardBundles[0]!.tier;
    const [material] = FLOOR1_COMMON_CRAFTING_MATERIALS;
    tampered.lootBoxRewardBundles[0]!.materials = Array.from({ length: 1000 }, () => material!);
    expect(tampered.lootBoxRewardBundles[0]!.materials.length).not.toBe(
      LOOT_BOX_MATERIAL_COUNT_BY_TIER[tier],
    );
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /expected .* for tier/,
    );
  });

  it('rejects a snapshot missing the bundle for an unlocked, unclaimed lootBox achievement', () => {
    const { dest, destPlayer, snapshot } = baseLootBoxSnapshot();
    const tampered = mutableClone(snapshot);
    // Strip the bundle out entirely — the achievement stays unlocked and
    // unclaimed, but has no way to ever be claimed under this snapshot.
    tampered.lootBoxRewardBundles = [];
    expect(() => restorePlayerCarryover(dest, destPlayer, tampered)).toThrow(
      /Missing loot box reward bundle for unlocked, unclaimed achievement/,
    );
  });
});
