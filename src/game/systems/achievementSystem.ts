import { query } from 'bitecs';
import { Player } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import {
  ACHIEVEMENT_CATALOG_REGISTRY,
  createEmptyAchievementFactSnapshot,
  getAchievementById,
  mergeAchievementFactSnapshots,
  FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER,
  type AchievementCatalogRegistry,
  type AchievementFactSnapshot,
  type AchievementNumberOperator,
  type AchievementRulePhase,
  type AchievementUnlockRule,
} from '../../shared/achievements.js';
import {
  FLOOR2_REWARD_POOL_STABLE_IDS,
  FLOOR2_REWARD_POOL_WEAPON_IDS,
} from '../../shared/data/floor2-reward-pool.js';
import { getFloor2EquipmentRewardsAccess } from '../../core/floor2-equipment-flags.js';
import { bandFor, getRelation } from '../../core/faction-relations.js';
import {
  RewardBundleResolutionError,
  resolveEquipmentRewardBundle,
  rollFloor2AchievementEquipmentDrop,
} from '../floor2-reward-bundle-resolver.js';
import {
  LootBoxRewardResolutionError,
  resolveLootBoxRewardBundle,
} from '../lootbox-materials-reward-resolver.js';

/**
 * Pre-computed set of Floor 2 weapon base IDs for category-weighted reward
 * selection (see {@link FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT} in
 * `floor2-reward-bundle-resolver.ts`). Built once at module load from the
 * same source array used by the reward pool — never hand-copied.
 */
const FLOOR2_REWARD_WEAPON_ID_SET: ReadonlySet<string> = new Set(FLOOR2_REWARD_POOL_WEAPON_IDS);

/**
 * Goal-flag key set once the player completes the Broker's settlement
 * introduction (`src/game/floor2Scenario.ts`, `FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID`).
 * Referenced here by its raw string literal rather than imported from
 * `floor2Scenario.ts`: that module already imports
 * `evaluateAchievementUnlocksForPhase` from this file, so importing the
 * constant back would create a real circular module dependency, not just add
 * coupling. Exported (test-only use) so a dedicated regression test
 * (`'stays in sync with floor2Scenario's broker-intro-complete goal flag key'`
 * in `tests/game/achievement-system.test.ts`) can import both constants and
 * assert string equality directly — that test, not the general fact-computation
 * tests, is what actually guards against the two literals drifting apart.
 */
export const FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID = 'floor2-broker-intro-complete';

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

/**
 * Count of Floor 2 present families currently at the given relationship band.
 * Reads live `world.factionRelations` state (via `getRelation`/`bandFor`), so
 * it reflects the current tick's standing rather than a historical peak.
 */
function familiesAtBandCount(world: GameWorld, band: ReturnType<typeof bandFor>): number {
  if (world.floor !== 2) return 0;
  const presentFamilies = world.floorExtendedState?.familyState?.presentFamilies ?? [];
  let count = 0;
  for (const familyId of presentFamilies) {
    if (bandFor(getRelation(world, familyId)) === band) {
      count += 1;
    }
  }
  return count;
}

/**
 * Whether the player currently has a family at neutral-or-better standing that
 * they've also landed at least one player-attributed trash kill against
 * ("double agent" behaviour).
 *
 * **Why neutral instead of friendly:** the `betrayerFlag` (originally checked
 * here) is never set by any production system — only by a dev-only lab.  The
 * replacement derivation is "family currently at neutral-or-better standing
 * despite recorded kills against them."  Friendly (≥ 76) is unreachable via
 * shipped mechanics: the maximum relation achievable through the six defined
 * emergent events is 68 (neutral band, 50–75).  Using neutral (≥ 50) as the
 * threshold makes the achievement reachable through normal gameplay — a
 * positive event (e.g. `tributeDelivered`, `pickASideChosen`) can push a
 * family from 45 (hostile default) into neutral, and the player can also kill
 * that family's trash mobs during the same run.
 */
function hasBetrayedFriendlyFamily(world: GameWorld): boolean {
  if (world.floor !== 2) return false;
  const familyState = world.floorExtendedState?.familyState;
  const presentFamilies = familyState?.presentFamilies ?? [];
  for (const familyId of presentFamilies) {
    const kills = familyState?.trashKillsByFamily?.get(familyId) ?? 0;
    const band = bandFor(getRelation(world, familyId));
    if (kills > 0 && (band === 'neutral' || band === 'friendly')) {
      return true;
    }
  }
  return false;
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
  // Track the running peak gold balance for the "Hoarder's Ledger" achievement.
  // Updated here (before facts are snapshotted) so the peak is captured even if
  // the player spends down before the next tick.
  world.peakGold = Math.max(world.peakGold, world.playerGold);

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
  const familyState = world.floor === 2 ? world.floorExtendedState?.familyState : undefined;
  const familyBossesDefeated = familyState?.decapitatedFamilies?.size ?? 0;
  // `bossEncounters` is seeded with a `started: false` entry for EVERY present
  // family at Floor 2 init (floor2Scenario.ts), so `.size` alone counts families
  // regardless of player engagement. Only count encounters the player has
  // actually started (entered the den).
  const familyBossEncounterCount = familyState?.bossEncounters
    ? [...familyState.bossEncounters.values()].filter((encounter) => encounter.started).length
    : 0;
  // `trashKillsByFamily` is likewise seeded with a 0-kill entry for every
  // present family at init, so `.size` counts families regardless of combat.
  // Only count families with at least one player-attributed trash kill.
  const familiesEngagedInCombatCount = familyState?.trashKillsByFamily
    ? [...familyState.trashKillsByFamily.values()].filter((kills) => kills > 0).length
    : 0;
  const familiesAtFriendlyCount = familiesAtBandCount(world, 'friendly');
  const familiesAtHateCount = familiesAtBandCount(world, 'hate');
  // Neutral-or-better: families at relation >= 50 (neutral or friendly band).
  // Positive emergent events can push families from hostile (45 default) into
  // neutral (50–75), so this threshold is reachable via shipped mechanics.
  const familiesAtNeutralOrBetterCount =
    world.floor === 2
      ? (familyState?.presentFamilies ?? []).filter(
          (id) =>
            bandFor(getRelation(world, id)) !== 'hostile' &&
            bandFor(getRelation(world, id)) !== 'hate',
        ).length
      : 0;
  const presentFamilyCount = world.floor === 2 ? (familyState?.presentFamilies?.length ?? 0) : 0;
  // Dynamic "every present family is Friendly" check — Floor 2's roster size
  // varies (3 or 4 families), so a fixed numeric threshold would either miss a
  // 4-family run or under-require a 3-family run.
  const allPresentFamiliesFriendly =
    presentFamilyCount > 0 && familiesAtFriendlyCount === presentFamilyCount;
  // Neutral-or-better variant: all present families at neutral standing or above.
  // Reachable via positive emergent events (max reachable relation ≈ 68 for
  // family 0, which is within the neutral band 50–75).
  const allPresentFamiliesNeutralOrBetter =
    presentFamilyCount > 0 && familiesAtNeutralOrBetterCount === presentFamilyCount;
  // Same dynamic-threshold reasoning as `allPresentFamiliesFriendly` above,
  // applied to combat instead of reputation — a fixed `>= 4` threshold would
  // be unreachable on the majority-case 3-family roster.
  const allPresentFamiliesEngagedInCombat =
    presentFamilyCount > 0 && familiesEngagedInCombatCount === presentFamilyCount;
  // Same dynamic-threshold reasoning, applied to boss-den engagement (started
  // the fight, not necessarily won it) — distinct from `familyBossesDefeated`,
  // which requires a win. Grounds a "braved every den" feat without requiring
  // the player to have cleared them all.
  const allPresentFamilyBossesEngaged =
    presentFamilyCount > 0 && familyBossEncounterCount === presentFamilyCount;
  const hasBetrayedAlly = hasBetrayedFriendlyFamily(world);
  // Deliberately NOT `isInSafeContext`: this is a fact about visiting the
  // floor-2 safe room, not a customization gate. `isInSafeContext` also admits
  // cleared boss arenas (ADR-0092), which are not safe rooms and must not
  // satisfy a "visited the safe room" feat.
  const floor2SafeRoomVisited =
    world.floor === 2 && (world.playerInSafeRoom || world.state === 'safe_room');
  const hasMetBroker = world.goalFlags.get(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID) === true;

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
      peakGold: world.peakGold,
      unlockedAbilityCount: unlockedAbilityCount(world),
      clearedFloorCount: floorCleared ? 1 : 0,
      familiesAtFriendlyCount,
      familiesAtHateCount,
      familiesAtNeutralOrBetterCount,
      familyBossesDefeated,
      familyBossEncounterCount,
      familiesEngagedInCombatCount,
    },
    booleanFacts: {
      ...empty.booleanFacts,
      allPresentFamiliesFriendly,
      allPresentFamiliesNeutralOrBetter,
      allPresentFamiliesEngagedInCombat,
      allPresentFamilyBossesEngaged,
      staircaseBattleStarted: floor1Objective?.bossBattles.get('staircase')?.started === true,
      staircaseSpawned:
        floor1Objective?.staircaseSpawned === true ||
        world.floorExtendedState?.familyState?.staircaseSpawned === true,
      staircaseUnlocked:
        floor1Objective?.staircaseUnlocked === true ||
        world.floorExtendedState?.familyState?.staircaseUnlocked === true,
      safeRoomDiscovered: floor1Objective?.safeRoomDiscovered === true,
      equipmentUnlocked: world.featureUnlocks.equipment,
      staircaseDiscovered:
        floor1Objective?.staircaseDiscovered === true ||
        world.floorExtendedState?.familyState?.staircaseDiscovered === true,
      runClearedFloor: floorCleared,
      hasBetrayedAlly,
      floor2SafeRoomVisited,
      hasMetBroker,
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

  // Equipment rewards resolve their immutable bundle BEFORE the unlock mutation
  // so the whole unlock is atomic: if the Floor 2 equipment economy is not
  // enabled (e.g. Floor 1, which is equipment-free), or bundle resolution fails
  // for any reason, we do NOT record the unlock (fail-closed).
  if (
    achievement.reward.type === 'lootBox' &&
    achievement.reward.lootTable === 'floor2-generated-equipment'
  ) {
    // getFloor2EquipmentRewardsAccess gates on floor + feature flags, but does
    // NOT itself check whether the generated-equipment registry has a run key
    // configured. A world could (in principle) have those flags enabled yet
    // still have no run key, which would otherwise hit the same "uncaught
    // throw from an unconfigured registry" landmine that the lootBox branch
    // below guards against explicitly — so mirror that guard here too.
    const runKey = world.generatedEquipmentRegistry.runKey;
    if (getFloor2EquipmentRewardsAccess(world).kind !== 'enabled' || runKey === null) {
      return false;
    }
    // Not every Floor 2 unlock hands out gear: lower tiers pass a deterministic
    // coin flip first (half the old always-equipment rate), and a missed roll
    // resolves Floor 2's OWN gold+materials payout instead — richer gold and a
    // wider material pool than Floor 1's table, which Floor 2 never reuses.
    // The decision is made ONCE here, at unlock, and is implied thereafter by
    // which bundle map holds the achievement's bundle.
    if (rollFloor2AchievementEquipmentDrop(runKey, achievementId, achievement.reward.tier)) {
      try {
        resolveEquipmentRewardBundle(
          world,
          achievementId,
          FLOOR2_REWARD_POOL_STABLE_IDS,
          FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER[achievement.reward.tier],
          FLOOR2_REWARD_WEAPON_ID_SET,
        );
      } catch (err) {
        if (err instanceof RewardBundleResolutionError) throw err;
        return false;
      }
    } else {
      try {
        resolveLootBoxRewardBundle(
          world,
          achievementId,
          achievement.reward.tier,
          'floor2-materials',
        );
      } catch (err) {
        if (err instanceof LootBoxRewardResolutionError) throw err;
        return false;
      }
    }
  } else if (achievement.reward.type === 'lootBox') {
    // Floor 1 lootBox rewards resolve their immutable gold+materials bundle
    // BEFORE the unlock mutation too, mirroring the equipment path exactly —
    // generation happens ONLY here, never at claim, load, or presentation.
    //
    // Mirroring the equipment branch's feature-availability pre-check above:
    // a world whose generated-equipment registry has no run key configured
    // has never opted into resolved-bundle generation at all (e.g. many
    // pre-existing ECS/headless test worlds built directly via
    // createGameWorld({ seed }) with no run key, which is a legitimate,
    // common configuration for tests unrelated to rewards). Treat that as
    // "reward resolution unavailable for this world" and fail closed here —
    // WITHOUT throwing — rather than letting the resolver's internal
    // no-run-key guard (a defense-in-depth invariant for callers that DO
    // expect a configured registry) turn every such world's real simulation
    // step into an uncaught crash the moment a trivial Floor 1 achievement
    // like 'quest-accepted' unlocks.
    if (world.generatedEquipmentRegistry.runKey === null) {
      return false;
    }
    try {
      resolveLootBoxRewardBundle(world, achievementId, achievement.reward.tier);
    } catch (err) {
      if (err instanceof LootBoxRewardResolutionError) throw err;
      return false;
    }
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
