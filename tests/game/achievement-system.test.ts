import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  initializeFloor1Scenario,
  confirmFloor1StairDescend,
} from '../../src/game/floorScenario.js';
import {
  achievementSystem,
  claimAchievementReward,
  isAchievementClaimed,
  unlockAchievement,
} from '../../src/game/systems/achievementSystem.js';
import { capturePlayerCarryover, restorePlayerCarryover } from '../../src/game/playerCarryover.js';
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

  it('carries run-global achievement facts across floor transitions and resets on a new run', () => {
    const floor1 = createTestWorld({ seed: 42 });
    const floor1Player = spawnPlayer(floor1, 0, 0);
    initializeFloor1Scenario(floor1, floor1Player);

    const objective = floor1.floorScenario!.objective;
    objective.ratsKilled = 5;
    objective.slimesKilled = 4;
    objective.safeRoomDiscovered = true;
    objective.staircaseSpawned = true;
    objective.staircaseUnlocked = true;
    objective.staircaseLocked = false;
    floor1.state = 'playing';

    floor1.questLog.set(
      FLOOR1_FIND_WELCOME_QUEST_ID,
      completeQuestState(FLOOR1_FIND_WELCOME_QUEST_ID),
    );

    expect(confirmFloor1StairDescend(floor1, floor1Player)).toBe(true);
    expect(floor1.achievements.runGlobal.numberFacts.totalKills).toBe(9);
    expect(floor1.achievements.runGlobal.completedQuestIds.has(FLOOR1_FIND_WELCOME_QUEST_ID)).toBe(
      true,
    );

    const carryover = capturePlayerCarryover(floor1, floor1Player);
    const floor2 = createTestWorld({ seed: 42, floor: 2 });
    const floor2Player = spawnPlayer(floor2, 0, 0);
    restorePlayerCarryover(floor2, floor2Player, carryover);

    expect(floor2.achievements.runGlobal.numberFacts.totalKills).toBe(9);
    expect(floor2.achievements.runGlobal.booleanFacts.staircaseDiscovered).toBe(true);
    expect(floor2.achievements.runGlobal.completedQuestIds.has(FLOOR1_FIND_WELCOME_QUEST_ID)).toBe(
      true,
    );

    const freshRun = createTestWorld({ seed: 42, floor: 2 });
    expect(freshRun.achievements.runGlobal.numberFacts.totalKills).toBe(0);
    expect(freshRun.achievements.runGlobal.completedQuestIds.size).toBe(0);
  });

  it('does not evaluate floor1 catalog entries on floor2', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    spawnPlayer(world, 0, 0);
    world.achievements.runGlobal.numberFacts.totalKills = 999;
    world.achievements.runGlobal.booleanFacts.staircaseUnlocked = true;

    achievementSystem(world);

    expect(world.achievements.unlockedIds.size).toBe(0);
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
