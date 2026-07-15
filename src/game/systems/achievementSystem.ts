import { query } from 'bitecs';
import { Player } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import {
  FLOOR1_ACHIEVEMENTS,
  getAchievementById,
  type AchievementBooleanFact,
  type AchievementNumberFact,
  type AchievementNumberOperator,
  type AchievementRulePhase,
  type AchievementUnlockRule,
} from '../../shared/achievements.js';

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

/**
 * Count total passive abilities granted to the player entity. Scoped to the
 * player only so non-player ability holders (if any are added in future) do not
 * inflate the achievement counter.
 *
 * Assumes at most one Player entity per world (the current single-player
 * constraint). Uses `players[0]` and returns 0 when no player exists (e.g.
 * during world initialization before spawnPlayer).
 */
function unlockedAbilityCount(world: GameWorld): number {
  const players = query(world.ecs, [Player]);
  const playerEid = players[0];
  if (playerEid === undefined) return 0;
  const state = world.abilityStatesByEntity.get(playerEid);
  return state?.passiveAbilityIds.length ?? 0;
}

interface AchievementFacts {
  readonly numberFacts: Record<AchievementNumberFact, number>;
  readonly booleanFacts: Record<AchievementBooleanFact, boolean>;
  readonly completedQuestIds: Set<string>;
}

function evaluateNumberCompare(
  left: number,
  op: AchievementNumberOperator,
  right: number,
): boolean {
  if (op === '>=') return left >= right;
  if (op === '>') return left > right;
  if (op === '<=') return left <= right;
  if (op === '<') return left < right;
  return left === right;
}

function evaluateUnlockRule(rule: AchievementUnlockRule, facts: AchievementFacts): boolean {
  if (rule.type === 'numberCompare') {
    return evaluateNumberCompare(facts.numberFacts[rule.fact], rule.op, rule.value);
  }
  if (rule.type === 'booleanIs') {
    return facts.booleanFacts[rule.fact] === rule.value;
  }
  return rule.questIds.every((questId) => facts.completedQuestIds.has(questId));
}

function collectAchievementFacts(world: GameWorld): AchievementFacts {
  const floor1Objective = world.floorScenario!.objective;
  const totalKills = floor1Objective.ratsKilled + floor1Objective.slimesKilled;
  const completedQuestIds = new Set(
    [...world.questLog.values()]
      .filter((quest) => quest.status === 'complete')
      .map((quest) => quest.questId),
  );

  return {
    numberFacts: {
      totalKills,
      slimesKilled: floor1Objective.slimesKilled,
      ratsKilled: floor1Objective.ratsKilled,
      maxSkillLevel: highestSkillLevel(world),
      spentStatPoints: spentStatPoints(world),
      goldCollected: floor1Objective.goldCollected,
      completedQuestCount: completedQuestIds.size,
      questLogSize: world.questLog.size,
      playerGold: world.playerGold,
      unlockedAbilityCount: unlockedAbilityCount(world),
    },
    booleanFacts: {
      staircaseBattleStarted: floor1Objective.bossBattles.get('staircase')?.started === true,
      staircaseUnlocked: floor1Objective.staircaseUnlocked,
      safeRoomDiscovered: floor1Objective.safeRoomDiscovered,
      equipmentUnlocked: world.featureUnlocks.equipment,
      staircaseDiscovered: floor1Objective.staircaseDiscovered,
      runClearedFloor: world.floorScenario?.runSummary?.outcome === 'cleared_floor',
    },
    completedQuestIds,
  };
}

function shouldUnlockAchievementForPhase(
  ruleSet: readonly AchievementUnlockRule[],
  facts: AchievementFacts,
  phase: AchievementRulePhase,
): boolean {
  const activeRules = ruleSet.filter((rule) => (rule.phase ?? 'tick') === phase);
  if (activeRules.length === 0) return false;
  return activeRules.every((rule) => evaluateUnlockRule(rule, facts));
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

export function evaluateAchievementUnlocksForPhase(
  world: GameWorld,
  phase: AchievementRulePhase,
): void {
  const floorScenario = world.floorScenario;
  if (!floorScenario || world.floor !== 1) {
    return;
  }

  const facts = collectAchievementFacts(world);
  for (const achievement of FLOOR1_ACHIEVEMENTS) {
    if (shouldUnlockAchievementForPhase(achievement.unlockRules, facts, phase)) {
      unlockAchievement(world, achievement.id);
    }
  }
}

export function achievementSystem(world: GameWorld): void {
  evaluateAchievementUnlocksForPhase(world, 'tick');
}

export {
  isAchievementClaimed,
  claimAchievementReward,
  type ClaimAchievementResult,
} from '../../core/systems/achievementRewards.js';
