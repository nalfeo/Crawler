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
  ACHIEVEMENT_CATALOG_REGISTRY,
  _FLOOR1_COMMON_CRAFTING_MATERIALS as FLOOR1_COMMON_CRAFTING_MATERIALS,
  _LOOT_BOX_GOLD_BY_TIER as LOOT_BOX_GOLD_BY_TIER,
  createAchievementCatalog,
  createAchievementCatalogRegistry,
  createEmptyAchievementFactSnapshot,
  FLOOR1_ACHIEVEMENTS,
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
  fact:
    | 'playerGold'
    | 'totalKills'
    | 'clearedFloorCount'
    | 'familyBossEncounterCount'
    | 'familiesEngagedInCombatCount',
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

    it('computes allPresentFamiliesFriendly dynamically against the actual present-family count (3 or 4 families)', () => {
      // Regression test: Floor 2 can spawn 3 OR 4 present families, so "Court
      // Favorite" must never use a fixed numeric threshold — it must compare
      // against the actual roster size for the run.
      const mirekin = asFamilyId('mirekin');
      const chitinous = asFamilyId('chitinous');
      const faceless = asFamilyId('faceless');
      const glimmerfolk = asFamilyId('glimmerfolk');

      const threeFamilyWorld = createTestWorld({ seed: 42, floor: 2 });
      threeFamilyWorld.factionRelations.set(mirekin, 90);
      threeFamilyWorld.factionRelations.set(chitinous, 90);
      threeFamilyWorld.factionRelations.set(faceless, 90);
      threeFamilyWorld.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous, faceless],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
        },
      };
      expect(
        collectCurrentFloorAchievementFacts(threeFamilyWorld).booleanFacts
          .allPresentFamiliesFriendly,
      ).toBe(true);

      const fourFamilyWorldPartial = createTestWorld({ seed: 42, floor: 2 });
      fourFamilyWorldPartial.factionRelations.set(mirekin, 90);
      fourFamilyWorldPartial.factionRelations.set(chitinous, 90);
      fourFamilyWorldPartial.factionRelations.set(faceless, 90);
      fourFamilyWorldPartial.factionRelations.set(glimmerfolk, 60); // neutral, not friendly
      fourFamilyWorldPartial.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous, faceless, glimmerfolk],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
        },
      };
      // Bug this guards against: a fixed ">= 3 friendly" rule would have
      // unlocked here even though the 4th present family is NOT Friendly.
      expect(
        collectCurrentFloorAchievementFacts(fourFamilyWorldPartial).booleanFacts
          .allPresentFamiliesFriendly,
      ).toBe(false);

      const fourFamilyWorldFull = createTestWorld({ seed: 42, floor: 2 });
      fourFamilyWorldFull.factionRelations.set(mirekin, 90);
      fourFamilyWorldFull.factionRelations.set(chitinous, 90);
      fourFamilyWorldFull.factionRelations.set(faceless, 90);
      fourFamilyWorldFull.factionRelations.set(glimmerfolk, 90);
      fourFamilyWorldFull.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous, faceless, glimmerfolk],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
        },
      };
      expect(
        collectCurrentFloorAchievementFacts(fourFamilyWorldFull).booleanFacts
          .allPresentFamiliesFriendly,
      ).toBe(true);
    });

    it('computes allPresentFamilyBossesEngaged dynamically against the actual present-family count (3 or 4 families)', () => {
      // Regression test: mirrors the allPresentFamiliesFriendly bug class —
      // "No Den Unbraved" must never use a fixed encounter-count threshold,
      // it must compare against the actual roster size for the run.
      const mirekin = asFamilyId('mirekin');
      const chitinous = asFamilyId('chitinous');
      const faceless = asFamilyId('faceless');
      const glimmerfolk = asFamilyId('glimmerfolk');

      const threeFamilyWorld = createTestWorld({ seed: 42, floor: 2 });
      threeFamilyWorld.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous, faceless],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
          bossEncounters: new Map([
            [mirekin, bossEncounter(mirekin)],
            [chitinous, bossEncounter(chitinous)],
            [faceless, bossEncounter(faceless)],
          ]),
        },
      };
      expect(
        collectCurrentFloorAchievementFacts(threeFamilyWorld).booleanFacts
          .allPresentFamilyBossesEngaged,
      ).toBe(true);

      const fourFamilyWorldPartial = createTestWorld({ seed: 42, floor: 2 });
      fourFamilyWorldPartial.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous, faceless, glimmerfolk],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
          bossEncounters: new Map([
            [mirekin, bossEncounter(mirekin)],
            [chitinous, bossEncounter(chitinous)],
            [faceless, bossEncounter(faceless)],
            // glimmerfolk's den never entered — this must stay false.
          ]),
        },
      };
      // Bug this guards against: a fixed ">= 3 encounters" rule would have
      // unlocked here even though the 4th present family's den was never entered.
      expect(
        collectCurrentFloorAchievementFacts(fourFamilyWorldPartial).booleanFacts
          .allPresentFamilyBossesEngaged,
      ).toBe(false);

      const fourFamilyWorldFull = createTestWorld({ seed: 42, floor: 2 });
      fourFamilyWorldFull.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous, faceless, glimmerfolk],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
          bossEncounters: new Map([
            [mirekin, bossEncounter(mirekin)],
            [chitinous, bossEncounter(chitinous)],
            [faceless, bossEncounter(faceless)],
            [glimmerfolk, bossEncounter(glimmerfolk)],
          ]),
        },
      };
      expect(
        collectCurrentFloorAchievementFacts(fourFamilyWorldFull).booleanFacts
          .allPresentFamilyBossesEngaged,
      ).toBe(true);
    });

    it('reports zero family-band/boss facts on Floor 1 (no family state at all)', () => {
      const world = createTestWorld({ seed: 42 });

      const facts = collectCurrentFloorAchievementFacts(world);

      expect(facts.numberFacts.familiesAtFriendlyCount).toBe(0);
      expect(facts.numberFacts.familiesAtHateCount).toBe(0);
      expect(facts.numberFacts.familyBossesDefeated).toBe(0);
      expect(facts.numberFacts.familyBossEncounterCount).toBe(0);
      expect(facts.numberFacts.familiesEngagedInCombatCount).toBe(0);
      expect(facts.booleanFacts.allPresentFamiliesFriendly).toBe(false);
      expect(facts.booleanFacts.allPresentFamilyBossesEngaged).toBe(false);
      expect(facts.booleanFacts.hasBetrayedAlly).toBe(false);
      expect(facts.booleanFacts.hasMetBroker).toBe(false);
    });

    it('excludes not-yet-started boss encounters from familyBossEncounterCount', () => {
      // Regression test: Floor 2 init seeds a `started: false` bossEncounters
      // entry for EVERY present family (floor2Scenario.ts), so a naive
      // `.size` count would report "Meet the Boss"-style achievements as
      // unlockable the instant the floor loads, before the player enters any
      // den.
      const world = createTestWorld({ seed: 42, floor: 2 });
      const mirekin = asFamilyId('mirekin');
      const chitinous = asFamilyId('chitinous');
      const faceless = asFamilyId('faceless');
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous, faceless],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
          bossEncounters: new Map([
            [mirekin, bossEncounter(mirekin)],
            [chitinous, { ...bossEncounter(chitinous), started: false }],
            [faceless, { ...bossEncounter(faceless), started: false }],
          ]),
        },
      };

      const facts = collectCurrentFloorAchievementFacts(world);

      expect(facts.numberFacts.familyBossEncounterCount).toBe(1);
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

      // Regression test: Floor 2 init seeds a 0-kill trashKillsByFamily entry
      // for EVERY present family, so only families with kills > 0 should
      // count — chitinous (0 kills) must NOT be counted as "engaged".
      expect(facts.numberFacts.familiesEngagedInCombatCount).toBe(1);
    });

    it('does not auto-unlock family-engagement achievements at Floor 2 init, only after real player progress', () => {
      // End-to-end regression test for the adversarial-review-found bugs:
      // a freshly initialized Floor 2 world (mirroring floor2Scenario.ts's
      // init-time eager seeding of bossEncounters/trashKillsByFamily for
      // every present family) must NOT unlock "Meet the Boss" or
      // "Two-Front War"-style achievements before the player has actually
      // engaged a boss den or dealt damage.
      const registry = createAchievementCatalogRegistry([
        createAchievementCatalog(2, [
          {
            ...scopedAchievement('floor2-boss-sighted', 'floor', 'familyBossEncounterCount'),
            unlockRules: [
              { type: 'numberCompare', fact: 'familyBossEncounterCount', op: '>=', value: 1 },
            ],
          },
          {
            ...scopedAchievement('floor2-two-front-war', 'floor', 'familiesEngagedInCombatCount'),
            unlockRules: [
              {
                type: 'numberCompare',
                fact: 'familiesEngagedInCombatCount',
                op: '>=',
                value: 2,
              },
            ],
          },
        ]),
      ]);
      const world = createTestWorld({ seed: 42, floor: 2 });
      const mirekin = asFamilyId('mirekin');
      const chitinous = asFamilyId('chitinous');
      // Mirrors floor2Scenario.ts's init-time state: every present family gets
      // a not-yet-started boss encounter and a 0-kill trash counter.
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin, chitinous],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
          bossEncounters: new Map([
            [mirekin, { ...bossEncounter(mirekin), started: false }],
            [chitinous, { ...bossEncounter(chitinous), started: false }],
          ]),
          trashKillsByFamily: new Map([
            [mirekin, 0],
            [chitinous, 0],
          ]),
        },
      };

      evaluateAchievementUnlocksForPhase(world, 'tick', registry);

      expect(world.achievements.unlockedIds.has('floor2-boss-sighted')).toBe(false);
      expect(world.achievements.unlockedIds.has('floor2-two-front-war')).toBe(false);
    });

    it('unlocks "Off This Floor" only at the run_end_clear phase, never at a regular tick', () => {
      // Regression test for the adversarial-review-found phase-timing bug:
      // confirmFloor2StairDescend evaluates achievements at the
      // 'run_end_clear' phase right before flipping world.state to
      // 'safe_room' (after which the per-tick achievementSystem() no longer
      // runs, since MainGameScene gates its update loop on
      // world.state === 'playing'). A rule with no explicit `phase` defaults
      // to 'tick' and would be silently excluded from that one evaluation
      // call, so it could never unlock. "Off This Floor"'s unlockRules must
      // carry phase: "run_end_clear" to fire at the correct moment.
      const world = createTestWorld({ seed: 42, floor: 2 });
      world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
      world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
      world.floor2EquipmentFlags.floor2EquipmentRewards = true;
      world.questLog.set('floor2-leave-floor', completeQuestState('floor2-leave-floor'));
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [asFamilyId('mirekin')],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
          staircaseDiscovered: true,
        },
      };

      evaluateAchievementUnlocksForPhase(world, 'tick', ACHIEVEMENT_CATALOG_REGISTRY);
      expect(world.achievements.unlockedIds.has('floor2-floor-cleared')).toBe(false);

      evaluateAchievementUnlocksForPhase(world, 'run_end_clear', ACHIEVEMENT_CATALOG_REGISTRY);
      expect(world.achievements.unlockedIds.has('floor2-floor-cleared')).toBe(true);
    });

    it('derives hasBetrayedAlly from a currently-neutral-or-better family with recorded trash kills', () => {
      // Regression test for the multi-model-review-found unreachability bug:
      // `betrayerFlag` is never set `true` by any production system (only a
      // dev-only lab), so `hasBetrayedAlly` must derive from real, already-
      // tracked facts — a present family currently at neutral-or-better standing
      // (relation >= 50) that also has at least one player-attributed trash kill.
      //
      // Why neutral instead of friendly: the maximum achievable relation via
      // shipped emergent events is ~68 (neutral band 50–75); the friendly band
      // (76+) is unreachable without wiring additional mechanics.
      const mirekin = asFamilyId('mirekin');
      const world = createTestWorld({ seed: 42, floor: 2 });
      world.factionRelations.set(mirekin, 90); // 'friendly' band (76-100) — also neutral-or-better
      world.floorExtendedState = {
        familyState: {
          presentFamilies: [mirekin],
          contestedResource: asResourceId('glimmercap'),
          betrayerFlag: false,
          trashKillsByFamily: new Map([[mirekin, 1]]),
        },
      };

      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.hasBetrayedAlly).toBe(true);

      // Neutral band (50–75) — the reachable case via positive emergent events —
      // should also trigger the betrayal signal when kills are recorded.
      world.factionRelations.set(mirekin, 60); // 'neutral' band
      world.floorExtendedState.familyState!.trashKillsByFamily = new Map([[mirekin, 1]]);
      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.hasBetrayedAlly).toBe(true);

      // Neutral-or-better standing alone, with no recorded kills, is not betrayal.
      world.floorExtendedState.familyState!.trashKillsByFamily = new Map([[mirekin, 0]]);
      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.hasBetrayedAlly).toBe(false);

      // Kills recorded, but the family is in hostile band — not betrayal by this definition.
      world.floorExtendedState.familyState!.trashKillsByFamily = new Map([[mirekin, 1]]);
      world.factionRelations.set(mirekin, 30); // 'hostile' band
      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.hasBetrayedAlly).toBe(false);
    });

    it('reads hasMetBroker from the Broker intro-complete goal flag', () => {
      const world = createTestWorld({ seed: 42, floor: 2 });
      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.hasMetBroker).toBe(false);

      world.goalFlags.set('floor2-broker-intro-complete', true);

      expect(collectCurrentFloorAchievementFacts(world).booleanFacts.hasMetBroker).toBe(true);
    });

    it("stays in sync with floor2Scenario's broker-intro-complete goal flag key", async () => {
      // achievementSystem.ts intentionally duplicates this goal-flag string
      // literal rather than importing it from floor2Scenario.ts (which would
      // create a circular module dependency, since floor2Scenario.ts already
      // imports evaluateAchievementUnlocksForPhase from achievementSystem.ts).
      // This test is the actual drift guard: it imports both source-of-truth
      // constants and asserts they are identical, so a rename on either side
      // fails loudly here instead of silently breaking "Meet the Broker" in
      // production.
      const { FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID: fromScenario } =
        await import('../../src/game/floor2Scenario.js');
      const { FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID: fromAchievementSystem } =
        await import('../../src/game/systems/achievementSystem.js');
      expect(fromAchievementSystem).toBe(fromScenario);
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
          // mirekin is at 'friendly' band (90), which satisfies neutral-or-better
          // standing — the real hasBetrayedAlly signal checks for a family at
          // neutral-or-better (>= 50) with recorded trash kills. (betrayerFlag
          // itself is dead/lab-only and intentionally ignored by achievementSystem.)
          trashKillsByFamily: new Map([[mirekin, 1]]),
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
      expect(result.reward).toEqual({
        type: 'lootBox',
        lootTable: 'floor1-materials',
        tier: 'trash',
      });
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
