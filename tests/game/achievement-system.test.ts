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
  fact: 'playerGold' | 'totalKills',
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
});

describe('claimAchievementReward', () => {
  it('opens an unlocked reward exactly once and reports the reward def', () => {
    const world = createTestWorld({ seed: 42 });
    unlockAchievement(world, 'first-bonk');

    expect(isAchievementClaimed(world, 'first-bonk')).toBe(false);
    const result = claimAchievementReward(world, 'first-bonk');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reward).toEqual({ type: 'lootBox', tier: 'trash' });
    }
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
