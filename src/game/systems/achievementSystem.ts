import { query } from 'bitecs';
import { Player } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import {
  ACHIEVEMENT_BOOLEAN_FACTS,
  ACHIEVEMENT_CURRENT_RUN_BOOLEAN_FACTS,
  ACHIEVEMENT_CURRENT_RUN_NUMBER_FACTS,
  ACHIEVEMENT_NUMBER_FACTS,
  createEmptyAchievementFactState,
  getAchievementCatalogForFloor,
  getAchievementById,
  isAchievementFloor,
  type AchievementBooleanFact,
  type AchievementDef,
  type AchievementNumberFact,
  type AchievementNumberOperator,
  type AchievementRulePhase,
  type AchievementScope,
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

const RUN_GLOBAL_SUM_FACTS: readonly AchievementNumberFact[] = [
  'totalKills',
  'slimesKilled',
  'ratsKilled',
  'goldCollected',
];

const RUN_GLOBAL_MAX_FACTS: readonly AchievementNumberFact[] = [
  'maxSkillLevel',
  'spentStatPoints',
  'questLogSize',
  'unlockedAbilityCount',
];

/**
 * Facts stored as the latest (most-recent-floor) value: values in this array
 * are overwritten on each floor transition rather than accumulated (sum) or
 * high-water-marked (max). `playerGold` is a point-in-time balance that can
 * decrease, so using Math.max would silently prevent `<` / `<=` / `===` rules
 * from ever seeing a reduced balance after a spending-heavy floor.
 */
const RUN_GLOBAL_LATEST_FACTS: readonly AchievementNumberFact[] = ['playerGold'];

const CURRENT_RUN_NUMBER_FACT_SET = new Set<AchievementNumberFact>(
  ACHIEVEMENT_CURRENT_RUN_NUMBER_FACTS,
);

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

function collectFloor1AchievementFacts(world: GameWorld): AchievementFacts | null {
  if (!world.floorScenario) {
    return null;
  }
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

function collectFloor2AchievementFacts(world: GameWorld): AchievementFacts | null {
  const floor2State = world.floorExtendedState?.familyState;
  if (!floor2State) {
    return null;
  }

  const totalKills = [...(floor2State.trashKillsByFamily?.values() ?? [])].reduce(
    (sum, value) => sum + value,
    0,
  );
  const completedQuestIds = new Set(
    [...world.questLog.values()]
      .filter((quest) => quest.status === 'complete')
      .map((quest) => quest.questId),
  );

  return {
    numberFacts: {
      totalKills,
      slimesKilled: 0,
      ratsKilled: 0,
      maxSkillLevel: highestSkillLevel(world),
      spentStatPoints: spentStatPoints(world),
      goldCollected: 0,
      completedQuestCount: completedQuestIds.size,
      questLogSize: world.questLog.size,
      playerGold: world.playerGold,
      unlockedAbilityCount: unlockedAbilityCount(world),
    },
    booleanFacts: {
      staircaseBattleStarted: false,
      staircaseUnlocked: floor2State.staircaseUnlocked === true,
      safeRoomDiscovered: false,
      equipmentUnlocked: world.featureUnlocks.equipment,
      staircaseDiscovered: floor2State.staircaseDiscovered === true,
      runClearedFloor: floor2State.staircaseDiscovered === true,
    },
    completedQuestIds,
  };
}

function collectFloorAchievementFacts(world: GameWorld): AchievementFacts | null {
  if (world.floor === 1) return collectFloor1AchievementFacts(world);
  if (world.floor === 2) return collectFloor2AchievementFacts(world);
  return null;
}

function mergeRunGlobalFacts(world: GameWorld, floorFacts: AchievementFacts): void {
  for (const fact of RUN_GLOBAL_SUM_FACTS) {
    world.achievements.runGlobal.numberFacts[fact] += floorFacts.numberFacts[fact];
  }
  for (const fact of RUN_GLOBAL_MAX_FACTS) {
    world.achievements.runGlobal.numberFacts[fact] = Math.max(
      world.achievements.runGlobal.numberFacts[fact],
      floorFacts.numberFacts[fact],
    );
  }
  for (const fact of RUN_GLOBAL_LATEST_FACTS) {
    world.achievements.runGlobal.numberFacts[fact] = floorFacts.numberFacts[fact];
  }
  for (const fact of ACHIEVEMENT_BOOLEAN_FACTS) {
    world.achievements.runGlobal.booleanFacts[fact] =
      world.achievements.runGlobal.booleanFacts[fact] || floorFacts.booleanFacts[fact];
  }
  for (const questId of [...floorFacts.completedQuestIds].sort()) {
    world.achievements.runGlobal.completedQuestIds.add(questId);
  }
  world.achievements.runGlobal.numberFacts.completedQuestCount =
    world.achievements.runGlobal.completedQuestIds.size;
}

function collectCurrentRunAchievementFacts(
  world: GameWorld,
  floorFacts: AchievementFacts | null,
): AchievementFacts {
  const facts = createEmptyAchievementFactState();
  for (const fact of ACHIEVEMENT_NUMBER_FACTS) {
    facts.numberFacts[fact] = world.achievements.runGlobal.numberFacts[fact];
  }
  for (const fact of ACHIEVEMENT_BOOLEAN_FACTS) {
    facts.booleanFacts[fact] = world.achievements.runGlobal.booleanFacts[fact];
  }
  for (const questId of world.achievements.runGlobal.completedQuestIds) {
    facts.completedQuestIds.add(questId);
  }

  if (!floorFacts) {
    facts.numberFacts.completedQuestCount = facts.completedQuestIds.size;
    return facts;
  }

  for (const fact of RUN_GLOBAL_SUM_FACTS) {
    if (!CURRENT_RUN_NUMBER_FACT_SET.has(fact)) continue;
    facts.numberFacts[fact] += floorFacts.numberFacts[fact];
  }
  for (const fact of RUN_GLOBAL_MAX_FACTS) {
    if (!CURRENT_RUN_NUMBER_FACT_SET.has(fact)) continue;
    facts.numberFacts[fact] = Math.max(facts.numberFacts[fact], floorFacts.numberFacts[fact]);
  }
  for (const fact of RUN_GLOBAL_LATEST_FACTS) {
    if (!CURRENT_RUN_NUMBER_FACT_SET.has(fact)) continue;
    facts.numberFacts[fact] = floorFacts.numberFacts[fact];
  }
  for (const fact of ACHIEVEMENT_CURRENT_RUN_BOOLEAN_FACTS) {
    facts.booleanFacts[fact] = facts.booleanFacts[fact] || floorFacts.booleanFacts[fact];
  }
  for (const questId of floorFacts.completedQuestIds) {
    facts.completedQuestIds.add(questId);
  }
  facts.numberFacts.completedQuestCount = facts.completedQuestIds.size;
  return facts;
}

function selectFactsForScope(
  scope: AchievementScope,
  floorFacts: AchievementFacts | null,
  runFacts: AchievementFacts,
): AchievementFacts | null {
  if (scope === 'current_run') {
    return runFacts;
  }
  return floorFacts;
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

export function unlockAchievement(
  world: GameWorld,
  achievementId: string,
  def?: AchievementDef,
): boolean {
  const achievement = def ?? getAchievementById(achievementId);
  if (!achievement || world.achievements.unlockedIds.has(achievementId)) {
    return false;
  }

  world.achievements.unlockedIds.add(achievementId);
  world.achievements.pendingUnlockIds.push(achievementId);
  return true;
}

function snapshotCurrentFloorIntoRunGlobalAchievementFacts(world: GameWorld): void {
  const floorFacts = collectFloorAchievementFacts(world);
  if (!floorFacts) return;
  mergeRunGlobalFacts(world, floorFacts);
}

export function finalizeFloorAchievementProgressOnExit(world: GameWorld): void {
  evaluateAchievementUnlocksForPhase(world, 'run_end_clear');
  snapshotCurrentFloorIntoRunGlobalAchievementFacts(world);
}

export function evaluateAchievementUnlocksForPhase(
  world: GameWorld,
  phase: AchievementRulePhase,
  catalogOverride?: readonly AchievementDef[],
): void {
  if (!isAchievementFloor(world.floor)) {
    return;
  }

  const floorFacts = collectFloorAchievementFacts(world);
  const runFacts = collectCurrentRunAchievementFacts(world, floorFacts);
  const catalog = catalogOverride ?? getAchievementCatalogForFloor(world.floor);
  for (const achievement of catalog) {
    const activeFacts = selectFactsForScope(achievement.scope, floorFacts, runFacts);
    if (!activeFacts) continue;
    if (shouldUnlockAchievementForPhase(achievement.unlockRules, activeFacts, phase)) {
      unlockAchievement(world, achievement.id, achievement);
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
