import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { asFamilyId, asResourceId } from '../../src/core/faction-relations.js';
import {
  initializeFloor1Scenario,
  confirmFloor1StairDescend,
} from '../../src/game/floorScenario.js';
import {
  achievementSystem,
  claimAchievementReward,
  collectCurrentFloorAchievementFacts,
  evaluateAchievementUnlocksForPhase,
  isAchievementClaimed,
  unlockAchievement,
} from '../../src/game/systems/achievementSystem.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  createAchievementCatalog,
  createAchievementCatalogRegistry,
  createEmptyAchievementFactSnapshot,
  FLOOR1_ACHIEVEMENTS,
  FLOOR1_COMMON_CRAFTING_MATERIALS,
  LOOT_BOX_GOLD_BY_TIER,
  type AchievementDef,
} from '../../src/shared/achievements.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
  FLOOR1_MEET_NPCS_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  type QuestState,
} from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

function completeQuestState(questId: string): QuestState {
  return {
    questId,
    status: 'complete',
    tracked: false,
    progress: {},
    done: {},
  };
}

function scopedAchievement(
  id: string,
  scope: 'floor' | 'current_run',
  fact: 'playerGold' | 'totalKills' | 'clearedFloorCount',
): AchievementDef {
  return {
    ...FLOOR1_ACHIEVEMENTS[0]!,
    id,
    floor: 2,
    scope,
    unlockRules: [{ type: 'numberCompare' as const, fact, op: '>=' as const, value: 50 }],
  };
}

describe('achievementSystem', () => {
  it('unlocks combat, quest, and progression achievements from real floor state', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);

    const objective = world.floorScenario!.objective;
    objective.ratsKilled = 20;
    objective.slimesKilled = 15;
    objective.goldCollected = 260;
    objective.safeRoomDiscovered = true;
    objective.staircaseUnlocked = true;
    world.playerLevel.level = 2;
    world.playerLevel.unspentPoints = 0;
    world.playerSkills.set('sword', {
      level: 6,
      usage: 0,
      itemBonus: 0,
      triggeredMilestones: new Set(),
    });
    world.featureUnlocks.equipment = true;

    world.questLog.set(
      FLOOR1_FIND_WELCOME_QUEST_ID,
      completeQuestState(FLOOR1_FIND_WELCOME_QUEST_ID),
    );
    world.questLog.set(FLOOR1_TUTORIAL_QUEST_ID, completeQuestState(FLOOR1_TUTORIAL_QUEST_ID));
    world.questLog.set(
      FLOOR1_BOSS_UNLOCK_QUEST_ID,
      completeQuestState(FLOOR1_BOSS_UNLOCK_QUEST_ID),
    );
    world.questLog.set(FLOOR1_MEET_NPCS_QUEST_ID, completeQuestState(FLOOR1_MEET_NPCS_QUEST_ID));
    world.questLog.set(FLOOR1_SHOP_QUEST_ID, completeQuestState(FLOOR1_SHOP_QUEST_ID));
    world.questLog.set(
      FLOOR1_BOSS_BATTLE_QUEST_ID,
      completeQuestState(FLOOR1_BOSS_BATTLE_QUEST_ID),
    );
    world.questLog.set(
      FLOOR1_LEAVE_FLOOR_QUEST_ID,
      completeQuestState(FLOOR1_LEAVE_FLOOR_QUEST_ID),
    );

    achievementSystem(world);

    expect(world.achievements.pendingUnlockIds).toEqual([
      'first-bonk',
      'slime-no-more',
      'rat-retired',
      'crowd-control',
      'skill-first-blood',
      'skill-five',
      'stat-point-spender',
      'gold-goblin',
      'stairs-unlocked',
      'quest-accepted',
      'quest-completed',
      'all-floor1-quests',
      'safe-room-discovered',
      'merchant-customer',
    ]);
    expect(world.achievements.unlockedIds.has('first-bonk')).toBe(true);
    expect(world.achievements.unlockedIds.has('rat-retired')).toBe(true);
    expect(world.achievements.unlockedIds.has('slime-no-more')).toBe(true);
    expect(world.achievements.unlockedIds.has('crowd-control')).toBe(true);
    expect(world.achievements.unlockedIds.has('skill-five')).toBe(true);
    expect(world.achievements.unlockedIds.has('stat-point-spender')).toBe(true);
    expect(world.achievements.unlockedIds.has('quest-accepted')).toBe(true);
    expect(world.achievements.unlockedIds.has('quest-completed')).toBe(true);
    expect(world.achievements.unlockedIds.has('all-floor1-quests')).toBe(true);
    expect(world.achievements.unlockedIds.has('gold-goblin')).toBe(true);
    expect(world.achievements.unlockedIds.has('safe-room-discovered')).toBe(true);
    expect(world.achievements.unlockedIds.has('stairs-unlocked')).toBe(true);
    expect(world.achievements.unlockedIds.has('merchant-customer')).toBe(true);
  });

  it('queues run-end unlocks when the player confirms stair descend', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);

    const objective = world.floorScenario!.objective;
    objective.staircaseSpawned = true;
    objective.staircaseUnlocked = true;
    objective.staircaseLocked = false;
    world.state = 'playing';
    world.playerGold = 25;

    expect(confirmFloor1StairDescend(world, player)).toBe(true);

    expect(world.achievements.unlockedIds.has('stairs-discovered')).toBe(true);
    expect(world.achievements.unlockedIds.has('floor1-clear')).toBe(true);
    expect(world.achievements.unlockedIds.has('broke-speedrun')).toBe(true);
    expect(world.floorScenario?.runSummary?.outcome).toBe('cleared_floor');
  });

  it('keeps carried run facts out of Floor 2 floor-scoped evaluation', () => {
    const registry = createAchievementCatalogRegistry([
      createAchievementCatalog(2, [
        scopedAchievement('floor2-local-gold', 'floor', 'playerGold'),
        scopedAchievement('floor2-run-kills', 'current_run', 'totalKills'),
      ]),
    ]);
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floorId = 'floor2';
    world.playerGold = 0;
    world.achievements.carriedRunFacts = {
      ...createEmptyAchievementFactSnapshot(),
      numberFacts: {
        ...createEmptyAchievementFactSnapshot().numberFacts,
        playerGold: 100,
        totalKills: 100,
      },
      reachedFloorIds: [1],
    };

    evaluateAchievementUnlocksForPhase(world, 'tick', registry);

    expect(world.achievements.unlockedIds.has('floor2-local-gold')).toBe(false);
    expect(world.achievements.unlockedIds.has('floor2-run-kills')).toBe(true);
  });

  it('does not activate a Floor 2-introduced current-run definition on Floor 1', () => {
    const registry = createAchievementCatalogRegistry([
      createAchievementCatalog(1, []),
      createAchievementCatalog(2, [
        scopedAchievement('floor2-run-gold', 'current_run', 'playerGold'),
      ]),
    ]);
    const world = createTestWorld({ seed: 42 });
    world.playerGold = 100;

    evaluateAchievementUnlocksForPhase(world, 'tick', registry);
    expect(world.achievements.unlockedIds.has('floor2-run-gold')).toBe(false);

    world.floor = 2;
    world.floorId = 'floor2';
    world.achievements.carriedRunFacts = {
      ...createEmptyAchievementFactSnapshot(),
      reachedFloorIds: [1, 2],
    };
    evaluateAchievementUnlocksForPhase(world, 'tick', registry);
    expect(world.achievements.unlockedIds.has('floor2-run-gold')).toBe(true);
  });

  it('keeps mixed-scope unlock ordering aligned with registry.all authored order', () => {
    const registry = createAchievementCatalogRegistry([
      createAchievementCatalog(1, [
        {
          ...scopedAchievement('floor1-run-kills', 'current_run', 'totalKills'),
          floor: 1,
          unlockRules: [{ type: 'numberCompare', fact: 'totalKills', op: '>=', value: 10 }],
        },
      ]),
      createAchievementCatalog(2, [scopedAchievement('floor2-local-gold', 'floor', 'playerGold')]),
    ]);
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floorId = 'floor2';
    world.playerGold = 50;
    world.achievements.carriedRunFacts = {
      ...createEmptyAchievementFactSnapshot(),
      numberFacts: {
        ...createEmptyAchievementFactSnapshot().numberFacts,
        totalKills: 10,
      },
      reachedFloorIds: [1],
    };

    evaluateAchievementUnlocksForPhase(world, 'tick', registry);

    expect(registry.all.map((achievement) => achievement.id)).toEqual([
      'floor1-run-kills',
      'floor2-local-gold',
    ]);
    expect(world.achievements.pendingUnlockIds).toEqual(['floor1-run-kills', 'floor2-local-gold']);
  });

  it('unlocks current-run clearedFloorCount achievements after two cleared floors', () => {
    const registry = createAchievementCatalogRegistry([
      createAchievementCatalog(2, [
        {
          ...scopedAchievement('two-floors-cleared', 'current_run', 'clearedFloorCount'),
          unlockRules: [{ type: 'numberCompare', fact: 'clearedFloorCount', op: '>=', value: 2 }],
        },
      ]),
    ]);
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floorId = 'floor2';
    const faceless = asFamilyId('faceless');
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [faceless],
        contestedResource: asResourceId('glimmercap'),
        betrayerFlag: false,
        trashKillsByFamily: new Map(),
        staircaseDiscovered: true,
      },
    };
    world.achievements.carriedRunFacts = {
      ...createEmptyAchievementFactSnapshot(),
      reachedFloorIds: [1],
      clearedFloorIds: [1],
    };

    evaluateAchievementUnlocksForPhase(world, 'tick', registry);

    expect(world.achievements.unlockedIds.has('two-floors-cleared')).toBe(true);
  });

  it('runs the Floor 2-safe evaluator through the real scene post-system pipeline', () => {
    const options = createFloorMainSceneOptions('floor2');
    const wiredAchievementSystem = options.postSystems?.find(
      (system) => system === achievementSystem,
    );
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floorId = 'floor2';
    world.floorScenario = null;

    expect(wiredAchievementSystem).toBe(achievementSystem);
    expect(() => wiredAchievementSystem?.(world)).not.toThrow();
  });

  it('collects Floor 2 player-attributed trash kills into the current-run total', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    const mirekin = asFamilyId('mirekin');
    const chitinous = asFamilyId('chitinous');
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [mirekin, chitinous],
        contestedResource: asResourceId('glimmercap'),
        betrayerFlag: false,
        trashKillsByFamily: new Map([
          [mirekin, 4],
          [chitinous, 7],
        ]),
      },
    };

    const facts = collectCurrentFloorAchievementFacts(world);

    expect(facts.numberFacts.totalKills).toBe(11);
    expect(facts.numberFacts.ratsKilled).toBe(0);
    expect(facts.numberFacts.slimesKilled).toBe(0);
  });

  it('unlockAchievement fails closed (no throw) on a lootBox achievement when the generated-equipment registry has no run key', () => {
    // Regression test: unlockAchievement's lootBox branch used to call
    // resolveLootBoxRewardBundle unconditionally, which throws
    // LootBoxRewardResolutionError('no-run-key', ...) whenever
    // world.generatedEquipmentRegistry.runKey is null — crashing any world
    // built without an explicit run key (a common, legitimate configuration
    // for tests/labs unrelated to rewards) the moment it reached a Floor 1
    // lootBox achievement like 'first-bonk'.
    const world = createTestWorld({ seed: 42, generatedEquipmentRunKey: null });

    expect(() => unlockAchievement(world, 'first-bonk')).not.toThrow();
    expect(unlockAchievement(world, 'first-bonk')).toBe(false);
    expect(world.achievements.unlockedIds.has('first-bonk')).toBe(false);
    expect(world.lootBoxRewardBundles.has('first-bonk')).toBe(false);
  });

  it('unlockAchievement fails closed (no throw) on an equipment achievement when Floor 2 flags are enabled but the registry has no run key', () => {
    // Mirrors the lootBox regression test above: getFloor2EquipmentRewardsAccess
    // gates on floor + feature flags but not on the run key itself, so an
    // equipment achievement could hit the identical
    // RewardBundleResolutionError('no-run-key', ...) landmine if a world ever
    // had the flags enabled without a configured run key.
    const world = createTestWorld({ seed: 42, floor: 2, generatedEquipmentRunKey: null });
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    world.floor2EquipmentFlags.floor2EquipmentRewards = true;

    expect(() => unlockAchievement(world, 'floor2-field-kit')).not.toThrow();
    expect(unlockAchievement(world, 'floor2-field-kit')).toBe(false);
    expect(world.achievements.unlockedIds.has('floor2-field-kit')).toBe(false);
    expect(world.generatedEquipmentRewardBundles.has('floor2-field-kit')).toBe(false);
  });

  describe('new Floor 2 achievement facts', () => {
    function bossEncounter(familyId: ReturnType<typeof asFamilyId>): {
      familyId: ReturnType<typeof asFamilyId>;
      roomId: number;
      doorEids: number[];
      activeGoalId: string;
      started: boolean;
      bossEid: number | null;
      defeated: boolean;
      displayName: string;
    } {
      return {
        familyId,
        roomId: 1,
        doorEids: [],
        activeGoalId: `floor2-boss-${familyId}`,
        started: true,
        bossEid: null,
        defeated: false,
        displayName: familyId,
      };
    }

    it('counts family relationship bands and boss defeats/encounters from live faction + family state', () => {
      const world = createTestWorld({ seed: 42, floor: 2 });
      const mirekin = asFamilyId('mirekin');
      const chitinous = asFamilyId('chitinous');
      const faceless = asFamilyId('faceless');
      world.factionRelations.set(mirekin, 90); // friendly
      world.factionRelations.set(chitinous, 10); // hate
      world.factionRelations.set(faceless, 60); // neutral
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous, faceless],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
          decapitatedFamilies: new Set([mirekin]),
          bossEncounters: new Map([
            [mirekin, bossEncounter(mirekin)],
            [chitinous, bossEncounter(chitinous)],
          ]),
        },
      };

      const facts = collectCurrentFloorAchievementFacts(world);

      expect(facts.numberFacts.familiesAtFriendlyCount).toBe(1);
      expect(facts.numberFacts.familiesAtHateCount).toBe(1);
      expect(facts.numberFacts.familyBossesDefeated).toBe(1);
      expect(facts.numberFacts.familyBossEncounterCount).toBe(2);
    });

    it('reports zero family-band/boss facts on Floor 1 (no family state at all)', () => {
      const world = createTestWorld({ seed: 42 });

      const facts = collectCurrentFloorAchievementFacts(world);

      expect(facts.numberFacts.familiesAtFriendlyCount).toBe(0);
      expect(facts.numberFacts.familiesAtHateCount).toBe(0);
      expect(facts.numberFacts.familyBossesDefeated).toBe(0);
      expect(facts.numberFacts.familyBossEncounterCount).toBe(0);
      expect(facts.numberFacts.familiesEngagedInCombatCount).toBe(0);
      expect(facts.booleanFacts.hasBetrayedAlly).toBe(false);
      expect(facts.booleanFacts.hasMetBroker).toBe(false);
    });

    it('counts distinct families with player-attributed trash kills as familiesEngagedInCombatCount', () => {
      const world = createTestWorld({ seed: 42, floor: 2 });
      const mirekin = asFamilyId('mirekin');
      const chitinous = asFamilyId('chitinous');
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
          trashKillsByFamily: new Map([
            [mirekin, 3],
            [chitinous, 0],
          ]),
        },
      };

      const facts = collectCurrentFloorAchievementFacts(world);

      expect(facts.numberFacts.familiesEngagedInCombatCount).toBe(2);
    });

    it('surfaces the betrayer flag as hasBetrayedAlly', () => {
      const world = createTestWorld({ seed: 42, floor: 2 });
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [asFamilyId('mirekin')],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: true,
        },
      };

      const facts = collectCurrentFloorAchievementFacts(world);

      expect(facts.booleanFacts.hasBetrayedAlly).toBe(true);
    });

    it('reads hasMetBroker from the Broker intro-complete goal flag', () => {
      const world = createTestWorld({ seed: 42, floor: 2 });
      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.hasMetBroker).toBe(false);

      world.goalFlags.set('floor2-broker-intro-complete', true);

      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.hasMetBroker).toBe(true);
    });

    it('reports floor2SafeRoomVisited only while on Floor 2 and in a safe context', () => {
      const world = createTestWorld({ seed: 42, floor: 2 });
      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.floor2SafeRoomVisited).toBe(
        false,
      );

      world.playerInSafeRoom = true;
      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.floor2SafeRoomVisited).toBe(
        true,
      );

      // Floor 1 never reports floor2SafeRoomVisited, even if the player is in a
      // safe room, since the fact is Floor-2-specific by name and design.
      world.floor = 1;
      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.floor2SafeRoomVisited).toBe(
        false,
      );
    });

    it('unlocks the new Floor 2 family/boss/settlement achievements from real constructed state', () => {
      const world = createTestWorld({ seed: 42, floor: 2 });
      world.floorId = 'floor2';
      world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
      world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
      world.floor2EquipmentFlags.floor2EquipmentRewards = true;
      const mirekin = asFamilyId('mirekin');
      const chitinous = asFamilyId('chitinous');
      const faceless = asFamilyId('faceless');
      world.factionRelations.set(mirekin, 90);
      world.factionRelations.set(chitinous, 90);
      world.factionRelations.set(faceless, 5);
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous, faceless],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: true,
          decapitatedFamilies: new Set([mirekin]),
          bossEncounters: new Map([[mirekin, bossEncounter(mirekin)]]),
        },
      };
      world.goalFlags.set('floor2-broker-intro-complete', true);
      world.playerInSafeRoom = true;
      world.questLog.set('floor2-find-settlement', completeQuestState('floor2-find-settlement'));

      achievementSystem(world);

      expect(world.achievements.unlockedIds.has('floor2-first-friend')).toBe(true);
      expect(world.achievements.unlockedIds.has('floor2-inner-circle')).toBe(true);
      expect(world.achievements.unlockedIds.has('floor2-court-favorite')).toBe(false);
      expect(world.achievements.unlockedIds.has('floor2-made-an-enemy')).toBe(true);
      expect(world.achievements.unlockedIds.has('floor2-double-agent')).toBe(true);
      expect(world.achievements.unlockedIds.has('floor2-boss-sighted')).toBe(true);
      expect(world.achievements.unlockedIds.has('floor2-den-breaker')).toBe(true);
      expect(world.achievements.unlockedIds.has('floor2-settlement-found')).toBe(true);
      expect(world.achievements.unlockedIds.has('floor2-meet-the-broker')).toBe(true);
      expect(world.achievements.unlockedIds.has('floor2-safe-harbor')).toBe(true);
    });
  });
});

describe('claimAchievementReward', () => {
  it('opens an unlocked lootBox reward exactly once, grants tier-scaled gold + materials', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    unlockAchievement(world, 'first-bonk');

    expect(isAchievementClaimed(world, 'first-bonk')).toBe(false);
    const goldBefore = world.playerGold;
    const result = claimAchievementReward(world, 'first-bonk');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reward).toEqual({ type: 'lootBox', tier: 'trash' });
      expect(result.grantedLootBox?.gold).toBe(LOOT_BOX_GOLD_BY_TIER.trash);
      expect(result.grantedLootBox?.materials).toHaveLength(1);
      for (const materialId of result.grantedLootBox?.materials ?? []) {
        expect(FLOOR1_COMMON_CRAFTING_MATERIALS).toContain(materialId);
      }
    }
    expect(world.playerGold).toBe(goldBefore + LOOT_BOX_GOLD_BY_TIER.trash);
    expect(isAchievementClaimed(world, 'first-bonk')).toBe(true);

    const second = claimAchievementReward(world, 'first-bonk');
    expect(second).toEqual({ ok: false, reason: 'alreadyClaimed' });
  });

  it('refuses to open locked or unknown achievements', () => {
    const world = createTestWorld({ seed: 42 });
    expect(claimAchievementReward(world, 'first-bonk')).toEqual({ ok: false, reason: 'locked' });
    expect(claimAchievementReward(world, 'not-real')).toEqual({ ok: false, reason: 'unknown' });
    expect(world.achievements.claimedIds.size).toBe(0);
  });
});
