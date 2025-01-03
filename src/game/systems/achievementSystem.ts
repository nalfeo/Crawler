import { query } from 'bitecs';
import { Player } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import {
  ACHIEVEMENT_CATALOG_REGISTRY,
  createEmptyAchievementFactSnapshot,
  getAchievementById,
  mergeAchievementFactSnapshots,
  type AchievementCatalogRegistry,
  type AchievementFactSnapshot,
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

function evaluateUnlockRule(rule: AchievementUnlockRule, facts: AchievementFactSnapshot): boolean {
  if (rule.type === 'numberCompare') {
    return evaluateNumberCompare(facts.numberFacts[rule.fact], rule.op, rule.value);
  }
  if (rule.type === 'booleanIs') {
    return facts.booleanFacts[rule.fact] === rule.value;
  }
  const completedQuestIds = new Set(facts.completedQuestIds);
  return rule.questIds.every((questId) => completedQuestIds.has(questId));
}

export function collectCurrentFloorAchievementFacts(world: GameWorld): AchievementFactSnapshot {
  const empty = createEmptyAchievementFactSnapshot();
  const floor1Objective = world.floor === 1 ? world.floorScenario?.objective : undefined;
  const floor2TrashKills =
    world.floor === 2
      ? [...(world.floorExtendedState?.familyState?.trashKillsByFamily?.values() ?? [])].reduce(
          (total, kills) => total + kills,
          0,
        )
      : 0;
  const questIds = [...world.questLog.values()].map((quest) => quest.questId).sort();
  const completedQuestIds = [...world.questLog.values()]
    .filter((quest) => quest.status === 'complete')
    .map((quest) => quest.questId)
    .sort();
  const floorCleared =
    (world.floor === 1 && world.floorScenario?.runSummary?.outcome === 'cleared_floor') ||
    (world.floor === 2 &&
      (world.floorExtendedState?.familyState?.staircaseDiscovered === true ||
        world.goalFlags.get('floor2.objective.staircaseDiscovered') === true));
  const ratsKilled = floor1Objective?.ratsKilled ?? 0;
  const slimesKilled = floor1Objective?.slimesKilled ?? 0;

  return {
    numberFacts: {
      ...empty.numberFacts,
      totalKills: ratsKilled + slimesKilled + floor2TrashKills,
      slimesKilled,
      ratsKilled,
      maxSkillLevel: highestSkillLevel(world),
      spentStatPoints: spentStatPoints(world),
      // Floor 2 has no floor-local earned-gold counter yet. Its current balance
      // remains available through playerGold without double-counting carryover.
      goldCollected: floor1Objective?.goldCollected ?? 0,
      completedQuestCount: completedQuestIds.length,
      questLogSize: world.questLog.size,
      playerGold: world.playerGold,
      unlockedAbilityCount: unlockedAbilityCount(world),
      clearedFloorCount: floorCleared ? 1 : 0,
    },
    booleanFacts: {
      ...empty.booleanFacts,
      staircaseBattleStarted: floor1Objective?.bossBattles.get('staircase')?.started === true,
      staircaseUnlocked:
        floor1Objective?.staircaseUnlocked === true ||
        world.floorExtendedState?.familyState?.staircaseUnlocked === true,
      safeRoomDiscovered: floor1Objective?.safeRoomDiscovered === true,
      equipmentUnlocked: world.featureUnlocks.equipment,
      staircaseDiscovered:
        floor1Objective?.staircaseDiscovered === true ||
        world.floorExtendedState?.familyState?.staircaseDiscovered === true,
      runClearedFloor: floorCleared,
    },
    questIds,
    completedQuestIds,
    reachedFloorIds: [world.floor],
    clearedFloorIds: floorCleared ? [world.floor] : [],
  };
}

function shouldUnlockAchievementForPhase(
  ruleSet: readonly AchievementUnlockRule[],
  facts: AchievementFactSnapshot,
  phase: AchievementRulePhase,
): boolean {
  const activeRules = ruleSet.filter((rule) => (rule.phase ?? 'tick') === phase);
  if (activeRules.length === 0) return false;
  return activeRules.every((rule) => evaluateUnlockRule(rule, facts));
}

export function unlockAchievement(
  world: GameWorld,
  achievementId: string,
  registry: AchievementCatalogRegistry = ACHIEVEMENT_CATALOG_REGISTRY,
): boolean {
  const achievement = getAchievementById(achievementId, registry);
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
  registry: AchievementCatalogRegistry = ACHIEVEMENT_CATALOG_REGISTRY,
): void {
  const currentFloorFacts = collectCurrentFloorAchievementFacts(world);
  const effectiveRunFacts = mergeAchievementFactSnapshots(
    world.achievements.carriedRunFacts,
    currentFloorFacts,
  );
  const reachedFloors = new Set(effectiveRunFacts.reachedFloorIds);

  for (const achievement of registry.all) {
    if (achievement.scope === 'current_run') {
      if (!reachedFloors.has(achievement.floor)) {
        continue;
      }
      if (shouldUnlockAchievementForPhase(achievement.unlockRules, effectiveRunFacts, phase)) {
        unlockAchievement(world, achievement.id, registry);
      }
      continue;
    }

    if (achievement.floor !== world.floor) {
      continue;
    }
    if (shouldUnlockAchievementForPhase(achievement.unlockRules, currentFloorFacts, phase)) {
      unlockAchievement(world, achievement.id, registry);
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
