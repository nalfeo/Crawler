import type { GameWorld } from '../../core/world.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
  FLOOR1_MEET_NPCS_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
} from '../../shared/quest-types.js';
import { getAchievementById } from '../../shared/achievements.js';

const ALL_FLOOR1_QUEST_IDS = [
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_MEET_NPCS_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
] as const;

function highestSkillLevel(world: GameWorld): number {
  let maxLevel = 0;
  for (const skill of world.playerSkills.values()) {
    if (skill.level > maxLevel) {
      maxLevel = skill.level;
    }
  }
  return maxLevel;
}

function spentStatPoints(world: GameWorld): number {
  const pointsGranted = world.playerLevel.level * world.playerLevel.pointsPerLevel;
  return Math.max(0, pointsGranted - world.playerLevel.unspentPoints);
}

export function unlockAchievement(world: GameWorld, achievementId: string): boolean {
  const achievement = getAchievementById(achievementId);
  if (!achievement || world.achievements.unlockedIds.has(achievementId)) {
    return false;
  }

  world.achievements.unlockedIds.add(achievementId);
  world.achievements.pendingUnlockIds.push(achievementId);
  return true;
}

export function achievementSystem(world: GameWorld): void {
  const floor1 = world.floor1;
  if (!floor1 || world.floor !== 1) {
    return;
  }

  const objective = floor1.objective;
  const totalKills = objective.ratsKilled + objective.slimesKilled;
  const staircaseBattleStarted = objective.bossBattles.get('staircase')?.started === true;
  const maxSkillLevel = highestSkillLevel(world);
  const completedQuestCount = [...world.questLog.values()].filter(
    (quest) => quest.status === 'complete',
  ).length;

  if (totalKills >= 1) unlockAchievement(world, 'first-bonk');
  if (objective.slimesKilled >= 1) unlockAchievement(world, 'slime-no-more');
  if (objective.ratsKilled >= 1) unlockAchievement(world, 'rat-retired');
  if (!staircaseBattleStarted && totalKills >= 30) unlockAchievement(world, 'crowd-control');
  if (totalKills >= 60) unlockAchievement(world, 'mob-eviction');
  if (totalKills >= 100) unlockAchievement(world, 'ratings-climbing');

  if (maxSkillLevel >= 1) unlockAchievement(world, 'skill-first-blood');
  if (maxSkillLevel >= 5) unlockAchievement(world, 'skill-five');
  if (maxSkillLevel >= 10) unlockAchievement(world, 'skill-ten');
  if (maxSkillLevel >= 15) unlockAchievement(world, 'skill-fifteen');
  if (maxSkillLevel >= 20) unlockAchievement(world, 'skill-twenty');

  if (spentStatPoints(world) >= 1) unlockAchievement(world, 'stat-point-spender');
  if (objective.goldCollected >= 250) unlockAchievement(world, 'gold-goblin');
  if (objective.staircaseUnlocked) unlockAchievement(world, 'stairs-unlocked');
  if (objective.safeRoomDiscovered) unlockAchievement(world, 'safe-room-discovered');
  if (world.featureUnlocks.equipment) unlockAchievement(world, 'merchant-customer');

  if (world.questLog.size > 0) unlockAchievement(world, 'quest-accepted');
  if (completedQuestCount > 0) unlockAchievement(world, 'quest-completed');

  const completedRequiredFloor1Quests = ALL_FLOOR1_QUEST_IDS.every(
    (questId) => world.questLog.get(questId)?.status === 'complete',
  );
  if (completedRequiredFloor1Quests) {
    unlockAchievement(world, 'all-floor1-quests');
  }
}
