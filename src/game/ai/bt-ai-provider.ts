/**
 * Behavior Tree AI input provider.
 *
 * Industry-standard behavior tree implementation that replaces the rule-based
 * state machine with composable, maintainable behavior trees.
 */

import { query, hasComponent, entityExists } from 'bitecs';
import {
  Player,
  Position,
  Health,
  Enemy,
  EnemyProjectile,
  AoeOnImpact,
  FamilyMembership,
  Velocity,
  XpGem,
  Gold,
  DroppedItem,
  Harvestable,
  Npc,
  HARVEST_RANGE_FT,
  computeMoveSpeed,
  type FamilyId,
  type GameWorld,
} from '../../core/index.js';
import { getBodyHalfHeight, getBodyHalfWidth } from '../../core/physics-body.js';
import type { FloorMap } from '../../core/map/FloorMap.js';
import type { InputState } from '../../shared/input.js';
import {
  findTilePath,
  PATH_TRAVERSAL,
  type PathfindingOptions,
  type TilePoint,
} from '../../core/map/pathfinding.js';
import { buildDoorAwarePassable, getNavigationBlockedDoors } from '../../core/door-navigation.js';
import { isPointInSafeSpace } from '../../core/safe-space.js';
import { resolveFloor2SettlementAnchor } from '../../core/floor2-settlement-anchor.js';
import { RoomRole, type TerritoryZone } from '../../shared/map-types.js';
import {
  type AILockedDoorMemory,
  type FrontierGrid,
  type PoiCandidate,
  DwellTracker,
  findNearestFrontierTile,
  nextStuckFrames,
  pickNearestPoi,
  updateLockedDoorMemory,
} from './exploration.js';
import { detectArenaLockin, type ArenaLockinTarget } from './arena-lockin.js';
import { normalizeInputDirection } from '../../shared/input.js';
import { hasItem } from '../../shared/inventory.js';
import { SeededRandom } from '../../shared/random.js';
import { createLogger } from '../../shared/logger.js';
import {
  GAME,
  WeaponType,
  PLAYER_SPEED,
  ENEMY_PROJECTILE,
  type WeaponTypeValue,
} from '../../shared/constants.js';
import { floor1Config } from '../../shared/floor-config.js';
import { getFloorManifest } from '../../shared/floor-registry.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  SHOPKEEPER_FETCH_ITEM_ID,
  type QuestState,
} from '../../shared/quest-types.js';
import { getItemById, getItemByIndex } from '../../shared/items.js';
import { getQuestObjectiveViews } from '../../core/systems/questSystem.js';
import {
  AIState,
  AIPathingMode,
  AIDecisionDebugState,
  AINpcInteractionAction,
  AIProgressSuppressionSource,
  type AIInputProvider,
  type AIDecision,
  type AIConfig,
  type AIDecisionModeValue,
  type AINpcInteractionActionValue,
  type AINpcInteractionIntent,
  type AIPathingModeValue,
  type AIProgressSuppressionSourceValue,
  type AISuppressedProgressNavDebug,
} from './types.js';
import {
  BehaviorTree,
  BTStatus,
  BTParallelPolicy,
  type BTContext,
  selector,
  sequence,
  condition,
  action,
  parallel,
  type BTNode,
} from './behavior-tree.js';
import {
  FLOOR1_QUEST_UNLOCK_LEVEL,
  getShopkeeperStage,
  SHOPKEEPER_EQUIPMENT_COST,
} from '../floorScenario.js';
import {
  FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID,
  FLOOR2_SETTLEMENT_FOUND_GOAL_ID,
  denUnlockGoalId,
} from '../floor2Scenario.js';
import { isEnemyCombatEligible } from '../floor2BossEligibility.js';
import {
  getActiveWeapon,
  getActiveWeaponReadiness,
  setPreferredWeaponTarget,
} from '../weaponSystem.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
// AI tuning constants (pure values; identical runtime behavior) live in
// ./bt-ai-tuning.ts. Imported here so every reference in this file is unchanged.
import {
  DEFAULT_CONFIG,
  DIRECT_MOVE_EPSILON_FT,
  RANGED_STANDOFF_FRACTION,
  RANGED_STANDOFF_ABS_FT,
  RANGED_DEFENSIVE_HP_FRACTION,
  RANGED_DEFENSIVE_REACH_FRACTION,
  RANGED_DEFENSIVE_ABS_FT,
  RANGED_DEFENSIVE_RELEASE_MULTIPLIER,
  RANGED_RECOVER_EXTRA_FRACTION,
  RANGED_APPROACH_BUFFER_FT,
  MELEE_HOLD_FRACTION,
  MELEE_RECOVER_HOLD_FRACTION,
  MELEE_DEFENSIVE_HP_FRACTION,
  ATTACK_GATE_MULTIPLIER,
  CONTACT_SAFE_ORBIT_FT,
  MELEE_DODGE_AMPLITUDE_FT,
  KITE_DODGE_BUFFER_FT,
  KITE_STEP_FT,
  KITE_RADIAL_STEP_FT,
  KITE_STRAFE_FT,
  KITE_BACK_THREAT_RADIUS_FT,
  RANGED_MULTI_THREAT_SCAN_FT,
  SAFE_LOOT_ENEMY_CLEARANCE_FT,
  LOOT_DETOUR_MAX_FT,
  LOCAL_XP_CLEANUP_RADIUS_FT,
  XP_CLEANUP_ENEMY_CLEARANCE_FT,
  XP_CLEANUP_MAX_FRAMES,
  XP_CLEANUP_COOLDOWN_FRAMES,
  XP_CLEANUP_COMBAT_LULL_WINDOW_FRAMES,
  XP_CLEANUP_MAX_PATH_CHECKS,
  EXIT_XP_CLEANUP_DETOUR_BUDGET_FT,
  KITE_FLIP_FRAMES,
  NAVIGATION_LOOKAHEAD_FT,
  MOVE_SMOOTH_FACTOR,
  CLOSE_APPROACH_DIRECT_FT,
  WAYPOINT_ARRIVE_FT,
  MOVE_WEDGE_PROGRESS_FT,
  MOVE_WEDGE_FRAMES,
  PATH_GOAL_SEARCH_RADIUS_TILES,
  STUCK_PROGRESS_EPSILON_FT,
  NAVIGATION_MAX_PATH_LENGTH,
  RESOLVE_GOAL_MEMO_MAX,
  ENEMY_IGNORE_FRAMES,
  ENGAGE_PROGRESS_EPSILON_FT,
  ENGAGE_GIVEUP_FRAMES,
  MIN_PLAYER_ENEMY_CONTACT_FT,
  ENGAGE_STALL_VELOCITY_THRESHOLD,
  LOOT_IGNORE_FRAMES,
  COLLECT_DWELL_ESCAPE_FT,
  COLLECT_DWELL_FRAMES,
  COLLECT_DWELL_CLUSTER_RADIUS_FT,
  EXPLORE_DWELL_ESCAPE_FT,
  EXPLORE_DWELL_FRAMES,
  PROGRESS_SUPPRESS_FRAMES,
  FLOOR2_HUNT_PATROL_ARRIVE_FT,
  FLOOR2_HUNT_PATROL_RADIUS_FRACTION,
  FLOOR2_HUNT_CHASE_RADIUS_FT,
  FLOOR2_HUNT_NO_PROGRESS_FRAMES,
  FLOOR2_HUNT_ENGAGE_FRAMES,
  FLOOR2_HUNT_RECOVERY_FRAMES,
  FLOOR2_HUNT_URGENCY_REMAINING_MS,
  EXPLORE_REACHABLE_SAMPLE_ATTEMPTS,
  EXPLORE_REACHABLE_SAMPLE_TARGET,
  EXPLORE_FAR_CANDIDATE_POOL,
  EXPLORE_FRONTIER_BFS_MAX_TILES,
  EXPLORE_FRONTIER_MIN_FT,
  GLOBAL_DWELL_ESCAPE_FT,
  GLOBAL_DWELL_FRAMES,
  GLOBAL_DWELL_ENEMY_PROGRESS_FT,
  QUEST_PROGRESS_STALL_FRAMES,
  SAFE_ROOM_EXIT_OVERSHOOT_FT,
  REACHABILITY_CACHE_TTL_FRAMES,
  REACHABILITY_GOAL_SEARCH_RADIUS_TILES,
  NAVIGATION_ANGLE_OFFSETS,
  RETREAT_HYSTERESIS_MULT,
  RETREAT_ARC_OFFSETS_RAD,
  RETREAT_DISTANCE_MULTS,
  RETREAT_THREAT_SCAN_FT,
  RETREAT_MAX_PATH_VERIFICATIONS,
  RETREAT_REPICK_INTERVAL_FRAMES,
  RETREAT_REPICK_ARRIVE_FT,
  GOLD_FARM_ENEMY_SCAN_RADIUS_FT,
  GOLD_FARM_GOLD_SCAN_RADIUS_FT,
  GOLD_FARM_COLLECT_RADIUS_FT,
  DODGE_THREAT_RADIUS_FT,
  DODGE_CLOSING_SPEED_FT_PER_FRAME,
  DODGE_BLOCK_RADIUS_FT,
  DODGE_BLOCK_AHEAD_DOT,
  PROJECTILE_DODGE_HORIZON_FRAMES,
  PROJECTILE_DODGE_CLEARANCE_FT,
  PROJECTILE_DODGE_AOE_BUFFER_FT,
  PROJECTILE_DODGE_VECTOR_SCALE,
  PATH_CORRIDOR_HALF_WIDTH_FT,
  DETOUR_MIN_HEADING_MAGNITUDE,
  FARM_FORWARD_SCAN_RADIUS_FT,
  FARM_FORWARD_DOT_MIN,
  FARM_MIN_HEALTH_FRACTION,
  FLOOR1_AI_COLLAPSE_PANIC_DEADLINE_MS,
  PANIC_BEELINE_REMAINING_MS,
  PANIC_RAMP_START_REMAINING_MS,
  PANIC_LOCKED_STAIRS_MULTIPLIER,
  PANIC_MIN_DODGE_WEIGHT_SCALE,
  PANIC_MIN_DODGE_WEIGHT_SCALE_LOCKED,
  PANIC_STAIRS_TRAVEL_SAFETY_MS,
  OBJECTIVE_TRAVEL_WALL_SAFETY_FACTOR,
  OBJECTIVE_TRAVEL_WALL_SAFETY_BUFFER_MS,
  OBJECTIVE_TRAVEL_ASTAR_REFRESH_TICKS,
  RUN_PLANNER_SAFETY_BUFFER_MS,
  RUN_PLANNER_URGENCY_SLACK_WINDOW_MS,
  RUN_PLANNER_INTERACTION_MS,
  RUN_PLANNER_LEVEL_2_GRIND_MS,
  RUN_PLANNER_QUEST_KILL_MS,
  RUN_PLANNER_GOLD_FARM_MS,
  RUN_PLANNER_FETCH_PICKUP_MS,
  RUN_PLANNER_MINOR_BOSS_KILL_MS,
  RUN_PLANNER_FINAL_BOSS_KILL_MS,
  RUN_PLANNER_STAIRS_INTERACT_MS,
  TACTICAL_OPPORTUNITY_SCAN_RADIUS_FT,
  TACTICAL_OPPORTUNITY_MAX_DETOUR_FT,
  TACTICAL_OPPORTUNITY_TRIVIAL_DETOUR_FT,
  TACTICAL_OPPORTUNITY_MIN_DETOUR_MS,
  TACTICAL_OPPORTUNITY_URGENCY_PENALTY,
  TACTICAL_OPPORTUNITY_DANGER_PENALTY,
  TACTICAL_OPPORTUNITY_ACCEPT_SCORE,
  TACTICAL_OPPORTUNITY_MAX_ACCEPTED,
  TACTICAL_OPPORTUNITY_TRAVEL_WEIGHT_DIVISOR,
  TACTICAL_OPPORTUNITY_MAX_TRAVEL_WEIGHT,
  TACTICAL_OPPORTUNITY_GOLD_VALUE,
  TACTICAL_OPPORTUNITY_ITEM_VALUE,
  TACTICAL_OPPORTUNITY_ENEMY_PACK_MIN_VALUE,
  TACTICAL_OPPORTUNITY_ENEMY_PACK_BASE_VALUE,
  TACTICAL_OPPORTUNITY_ENEMY_PACK_HP_PENALTY,
  TACTICAL_TRAVEL_W_LOOT,
  QUEST_GIVER_DETOUR_MAX_EXTRA_FT,
  QUEST_GIVER_DETOUR_MAX_EXTRA_FRACTION,
  QUEST_GIVER_DETOUR_COMMIT_HYSTERESIS,
  QUEST_GIVER_DETOUR_ABANDON_FRAMES,
  NPC_INTERACTION_RADIUS_FT,
  NPC_APPROACH_THREAT_RADIUS_FT,
  NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES,
  ARENA_LOCKIN_ADD_HYSTERESIS_FT,
  ARENA_LOCKIN_DEFENSIVE_HP_FRACTION,
  ARENA_LOCKIN_ADD_PRESSURE_FT,
  TRAVEL_STEERING_ENABLED,
  TRAVEL_BODY_RADIUS_FT,
  TRAVEL_HARD_GAP_FT,
  TRAVEL_SAFE_GAP_FT,
  TRAVEL_COMFORT_GAP_FT,
  TRAVEL_THREAT_RADIUS_FT,
  TRAVEL_HORIZON_FRAMES,
  TRAVEL_CANDIDATE_OFFSETS_DEG,
  TRAVEL_WALL_PROBE_DISTANCES_FT,
  TRAVEL_MIN_SAFE_PROGRESS_DOT,
  TRAVEL_W_PROGRESS,
  TRAVEL_W_SAFETY,
  TRAVEL_W_CONTINUITY,
  TRAVEL_W_KITE,
  TRAVEL_W_LOOT,
  TRAVEL_W_FARM,
  TRAVEL_LOOT_LOOKAHEAD_FT,
  TRAVEL_LOOT_CORRIDOR_FT,
  TRAVEL_REL_SPEED_EPSILON_SQ,
  TRAVEL_COLLECT_MIN_STEER_DIST_FT,
} from './bt-ai-tuning.js';
// Floor-progress scoring + its weight live in ./scoring.ts (re-exported below so
// this module's public surface is unchanged).
import { computeFloorProgressScore } from './scoring.js';
// Pure line-of-sight sampling lives in ./bt-ai-geometry.ts (unit-tested).
import { hasClearLineOfSight } from './bt-ai-geometry.js';
// Pure predictive safe-gap travel steering (unit-tested; damage-agnostic).
import {
  pickSafeTravelHeading,
  type TravelSteeringInput,
  type TravelSteeringParams,
  type TravelThreat,
  type TravelSteeringResult,
  type TravelPickup,
} from './travel-steering.js';
import {
  buildRunPlanCacheKey,
  estimateFloor1RunPlan,
  planFloor1ObjectiveRoute,
  type Floor1RunPlan,
  type Floor1RunPlannerSnapshot,
  type RunPlanSegmentPhase,
  type RunPlannerCurrentTargetKind,
  type RunPlannerParams,
} from './run-planner.js';
import { getMerchantWeaponIntent, updateMerchantWeaponIntent } from './merchant-weapon-intent.js';
import {
  getSettlementReturnIntent,
  isSettlementReturnRoutingEnabled,
  updateSettlementReturnIntent,
} from './settlement-return-router.js';
import {
  estimateObjectiveTravelMs,
  type ObjectiveTravelAdapters,
} from './objective-travel-estimate.js';
import {
  applyFloor1WorkCosts,
  buildFloor1GoalGraph,
  PLAYER_START_LOCATION,
} from './floor1-goal-graph.js';
import { makeFloor1DoorAwareTravelOracle } from './floor1-travel-oracle.js';
import { planObjectiveRoute } from './objective-route-planner.js';
import {
  evaluateTacticalOpportunities,
  projectTacticalObjectiveLookahead,
  type TacticalOpportunityCandidate,
  type TacticalOpportunityEvaluation,
  type TacticalOpportunityParams,
  type TacticalPickupKind,
} from './tactical-opportunity-evaluator.js';

const logger = createLogger('game:bt-ai-provider');
export const SAFE_ROOM_EGRESS_EXIT_HYSTERESIS_FRAMES = 30;
export const SAFE_ROOM_EGRESS_NO_PROGRESS_FRAMES = 45;
const SAFE_ROOM_EGRESS_PROGRESS_EPSILON_FT = 3;
const SAFE_ROOM_EGRESS_MAX_ACTIVE_FRAMES = 300;
export const SAFE_ROOM_EGRESS_SUPPRESS_FRAMES = 120;

const MERCHANT_DECISION_RUN_PLAN_CACHE_FRAMES = 30;

// Below this magnitude a heading is treated as "no direction" (skip steering /
// neutral continuity) — matches the pure module's own zero-vector epsilon.
const TRAVEL_HEADING_EPSILON = 1e-6;

// --- RISK_REWARD_FUSED pathing (AIPathingMode.RISK_REWARD_FUSED) -------------
// The fused heading scorer samples candidate directions fanned around the
// desired (Track A + Track B) heading and picks the one that best trades
// objective progress + reward pull against sampled overlap-danger, so the AI
// prefers low-risk "seams" when moving through enemy pressure fields. All
// constants are dormant unless pathingMode === RISK_REWARD_FUSED.
const RISK_REWARD_CANDIDATE_OFFSETS_DEG = [
  0, -15, 15, -30, 30, -45, 45, -60, 60, -75, 75, -90, 90,
] as const;
const RISK_REWARD_DANGER_LOOKAHEAD_FT = 8;
const RISK_REWARD_DANGER_RADIUS_FT = 9; // retuned for spawner-free Floor 1: a following near-player danger bubble means a wide halo is high in EVERY forward direction → progress paralysis; tighten to genuinely-imminent overlap only

// Enemy hostile-fireball weapon def, shared with enemyAISystem.ts's real fire
// logic (see fireEnemyProjectileFrom) — kept here too so the telegraph-threat
// dodge math below uses the SAME projectile speed/AOE radius the real shot
// will actually use, rather than guessing at ENEMY_PROJECTILE defaults.
const TELEGRAPH_FIREBALL_DEF = getWeaponDef('fireball');
const RISK_REWARD_W_PROGRESS = 1.0; // baseline — danger must reliably beat this
const RISK_REWARD_W_REWARD = 0.95;
const RISK_REWARD_W_DANGER = 1.0; // retuned 1.8→1.0: on a director map danger is a local deflection nudge, not a progress-dominating force (was tuned for a static swarm)
// Continuity bonus: small nudge toward the previous frame's heading to dampen
// oscillation when candidates score nearly equally (e.g. dense symmetric packs).
const RISK_REWARD_W_CONTINUITY = 0.18;
// Walls amplify danger from nearby enemies — being trapped against a wall with
// an enemy is worse than facing that enemy in open space. Walls alone (no enemies
// nearby) produce NO danger, so open-but-adjacent-to-wall corridors are still safe.
const RISK_REWARD_WALL_AMPLIFICATION = 2.4;
// Unseen-area baseline: on spawner-free Floor 1 the exit is ALWAYS reached by
// pushing through fog, and enemies spawn near the player (not hidden in fog), so a
// fog penalty just taxes the only path to victory. Retuned 0.35→0.0.
const RISK_REWARD_FOG_DANGER = 0.0;
// Door-crossing penalty: progress requires crossing doors and nothing ambushes from
// behind them on a near-player director. Retuned 0.6→0.0.
const RISK_REWARD_DOOR_DANGER = 0.0;
// How many frames ahead to project enemy positions via their current velocity.
// Enemies always move toward the player (flow-map driven), so the projected
// position is always at least as close — use it directly.
const RISK_REWARD_VELOCITY_LOOKAHEAD_FRAMES = 14;
// Wall proximity check: if a wall is within this many ft perpendicular to the
// travel direction, the corridor is considered "wall-adjacent" and the amplifier
// is applied even when the ray centre stays passable.
const RISK_REWARD_WALL_PROXIMITY_FT = 2.0;

/**
 * Read-only snapshot of the RISK_REWARD_FUSED field constants, exported so debug
 * visualizers (the ai-runner lab heatmap) can mirror the scorer WITHOUT
 * re-declaring the numbers. Re-declaring them is how the lab overlay silently
 * drifted from the scorer (wall-amp / lookahead / radius mismatches); importing
 * this bundle keeps the danger side of the heatmap faithful to the real weights.
 */
export const RISK_REWARD_FIELD_CONSTANTS = Object.freeze({
  dangerLookaheadFt: RISK_REWARD_DANGER_LOOKAHEAD_FT,
  dangerRadiusFt: RISK_REWARD_DANGER_RADIUS_FT,
  wallAmplification: RISK_REWARD_WALL_AMPLIFICATION,
  wallProximityFt: RISK_REWARD_WALL_PROXIMITY_FT,
  fogDanger: RISK_REWARD_FOG_DANGER,
  doorDanger: RISK_REWARD_DOOR_DANGER,
  velocityLookaheadFrames: RISK_REWARD_VELOCITY_LOOKAHEAD_FRAMES,
});

/** One scored candidate heading from a single fused-scorer poll (debug only). */
export interface FusedCandidateDebug {
  /** Offset from the desired (Track A+B) heading, degrees. 0 = straight ahead. */
  angleDeg: number;
  /** Unit heading of this candidate. */
  dirX: number;
  dirY: number;
  /** Pre-weight component terms (so the viz can show WHY a candidate scored). */
  progress: number;
  reward: number;
  danger: number;
  continuity: number;
  /** Final weighted score actually compared by the scorer. */
  score: number;
  /** True for the single candidate the scorer selected this poll. */
  chosen: boolean;
}

/**
 * Snapshot of one RISK_REWARD_FUSED scoring poll, captured ONLY when
 * {@link BehaviorTreeAI.fusedDebugCapture} is enabled (lab/debug). Default-off so
 * the headless runner / A/B sweep path allocates nothing and stays byte-identical
 * to the validated gate. Pure data (no rendering types) — never read back into
 * any decision, so it cannot perturb determinism.
 */
export interface FusedHeadingDebug {
  playerX: number;
  playerY: number;
  /** The desired heading (Track A objective blended with Track B pull) = 0° candidate. */
  desiredX: number;
  desiredY: number;
  /** The chosen heading (== the `chosen` candidate's dir). */
  bestX: number;
  bestY: number;
  bestScore: number;
  /** Ray length the scorer samples danger at, feet (for drawing candidate rays). */
  lookaheadFt: number;
  dangerRadiusFt: number;
  /**
   * Velocity-projected enemy threat points the scorer actually scored
   * against. `radiusFt` is per-threat (Math.max(base danger radius, that
   * enemy's actual ranged attackRange) — a long-range shooter's danger
   * bubble extends to its real reach, not just the generic near-body radius.
   */
  threats: { x: number; y: number; radiusFt: number }[];
  candidates: FusedCandidateDebug[];
}

// Assembled once from the TRAVEL_* tuning constants; the pure steering module
// reads it by reference each frame and never mutates it.
const TRAVEL_PARAMS: TravelSteeringParams = {
  hardGapFt: TRAVEL_HARD_GAP_FT,
  safeGapFt: TRAVEL_SAFE_GAP_FT,
  comfortGapFt: TRAVEL_COMFORT_GAP_FT,
  threatRadiusFt: TRAVEL_THREAT_RADIUS_FT,
  horizonFrames: TRAVEL_HORIZON_FRAMES,
  candidateOffsetsDeg: TRAVEL_CANDIDATE_OFFSETS_DEG,
  wallProbeDistancesFt: TRAVEL_WALL_PROBE_DISTANCES_FT,
  minSafeProgressDot: TRAVEL_MIN_SAFE_PROGRESS_DOT,
  wProgress: TRAVEL_W_PROGRESS,
  wSafety: TRAVEL_W_SAFETY,
  wContinuity: TRAVEL_W_CONTINUITY,
  wKite: TRAVEL_W_KITE,
  wLoot: TRAVEL_W_LOOT,
  wFarm: TRAVEL_W_FARM,
  lootLookaheadFt: TRAVEL_LOOT_LOOKAHEAD_FT,
  lootCorridorFt: TRAVEL_LOOT_CORRIDOR_FT,
  relSpeedEpsilonSq: TRAVEL_REL_SPEED_EPSILON_SQ,
};

const RUN_PLANNER_PARAMS: RunPlannerParams = {
  moveSpeedFtPerMs: PLAYER_SPEED / GAME.DELTA_MS,
  safetyBufferMs: RUN_PLANNER_SAFETY_BUFFER_MS,
  urgencySlackWindowMs: RUN_PLANNER_URGENCY_SLACK_WINDOW_MS,
  interactionMs: RUN_PLANNER_INTERACTION_MS,
  level2GrindMs: RUN_PLANNER_LEVEL_2_GRIND_MS,
  questKillMs: RUN_PLANNER_QUEST_KILL_MS,
  goldFarmMs: RUN_PLANNER_GOLD_FARM_MS,
  fetchPickupMs: RUN_PLANNER_FETCH_PICKUP_MS,
  minorBossKillMs: RUN_PLANNER_MINOR_BOSS_KILL_MS,
  finalBossKillMs: RUN_PLANNER_FINAL_BOSS_KILL_MS,
  stairsInteractMs: RUN_PLANNER_STAIRS_INTERACT_MS,
};

const TACTICAL_OPPORTUNITY_PARAMS: TacticalOpportunityParams = {
  scanRadiusFt: TACTICAL_OPPORTUNITY_SCAN_RADIUS_FT,
  maxDetourFt: TACTICAL_OPPORTUNITY_MAX_DETOUR_FT,
  minDetourMs: TACTICAL_OPPORTUNITY_MIN_DETOUR_MS,
  urgencyPenalty: TACTICAL_OPPORTUNITY_URGENCY_PENALTY,
  dangerPenalty: TACTICAL_OPPORTUNITY_DANGER_PENALTY,
  acceptScore: TACTICAL_OPPORTUNITY_ACCEPT_SCORE,
  maxAccepted: TACTICAL_OPPORTUNITY_MAX_ACCEPTED,
  travelWeightDivisor: TACTICAL_OPPORTUNITY_TRAVEL_WEIGHT_DIVISOR,
  maxTravelWeight: TACTICAL_OPPORTUNITY_MAX_TRAVEL_WEIGHT,
};

// Re-exported so bt-ai-provider.ts's public surface is unchanged: no importer
// (or its existing unit test) needs to change.
export { computeFloorProgressScore };

type LootKind = 'xp' | 'gold' | 'item' | 'harvest';

interface WorldTarget {
  eid: number;
  x: number;
  y: number;
  distance: number;
}

interface LootTarget extends WorldTarget {
  kind: LootKind;
}

interface ProgressTarget extends WorldTarget {
  reason: string;
  npcInteraction: AINpcInteractionIntent | null;
}

function floor1GoalIdForNpcInteraction(action: AINpcInteractionActionValue | null): string | null {
  switch (action) {
    case AINpcInteractionAction.ACCEPT_TUTORIAL_QUEST:
      return 'meet-tutorial-goon';
    case AINpcInteractionAction.MEET_SHOPKEEPER:
      return 'meet-shopkeeper';
    case AINpcInteractionAction.RETURN_SHOPKEEPER_PRIZE:
      return 'return-shop-prize';
    case AINpcInteractionAction.BUY_SHOPKEEPER_EQUIPMENT:
      return 'buy-shop-charm';
    case AINpcInteractionAction.ACCEPT_SPELL_QUEST:
      return 'accept-spell-quest';
    case AINpcInteractionAction.CLAIM_SPELL_REWARD:
      return 'claim-spell-reward';
    case AINpcInteractionAction.GENERIC_INTERACTION:
    case AINpcInteractionAction.MEET_BROKER_INTRO:
    case null:
      return null;
  }
}

/**
 * Every projectile-firing weapon (RANGED, MAGIC, THROWN, BEAM) kites/auto-fires
 * at a standoff instead of needing melee contact. TRAP and MELEE are not
 * projectile weapons and still require closing distance.
 */
function isProjectileWeaponType(weaponType: WeaponTypeValue): boolean {
  return (
    weaponType === WeaponType.RANGED ||
    weaponType === WeaponType.MAGIC ||
    weaponType === WeaponType.THROWN ||
    weaponType === WeaponType.BEAM
  );
}

interface CollapsePanicInput {
  elapsedMs: number;
  deadlineMs: number;
  staircaseUnlocked: boolean;
  staircaseDiscovered: boolean;
  /**
   * Deterministic AI estimate of the current travel time (ms) from the player
   * to the Floor 1 staircase entry marker. When provided and the run is in the
   * post-unlock/pre-discovery phase, the beeline threshold escalates to at
   * least {@link CollapsePanicInput.playerToStairsTravelMs} +
   * {@link PANIC_STAIRS_TRAVEL_SAFETY_MS} so that the AI drops optional
   * detours in time to physically reach the stairs before the collapse
   * deadline. Callers pass `null`/`undefined` to preserve the legacy
   * fixed-threshold behavior; non-finite / negative values are ignored so
   * callers do not have to sanitize inputs.
   */
  playerToStairsTravelMs?: number | null;
}

export interface CollapsePanicProfile {
  remainingMs: number | null;
  panic: number;
  beeline: boolean;
  stairsUnlocked: boolean;
  /** True when {@link beeline} fired specifically because the AI's travel-time
   * estimate to the stairs exceeded the remaining collapse budget. Useful for
   * debug/telemetry and unit-test assertions; downstream behavior treats this
   * bit the same as the legacy remaining-time beeline. */
  travelBeelineActive: boolean;
}

export function resolveFloor1AiCollapsePanicDeadlineMs(objectiveDeadlineMs: number): number {
  return Math.min(objectiveDeadlineMs, FLOOR1_AI_COLLAPSE_PANIC_DEADLINE_MS);
}

export function computeCollapsePanicProfile(
  input: CollapsePanicInput | null | undefined,
): CollapsePanicProfile {
  if (!input) {
    return {
      remainingMs: null,
      panic: 0,
      beeline: false,
      stairsUnlocked: true,
      travelBeelineActive: false,
    };
  }
  const remainingMs = Math.max(0, input.deadlineMs - input.elapsedMs);
  const stairsMultiplier = input.staircaseUnlocked ? 1 : PANIC_LOCKED_STAIRS_MULTIPLIER;

  // Phase-gate the travel-derived threshold to the post-unlock/pre-discovery
  // window. Before the staircase is unlocked, the AI still has real
  // prerequisite work to do (quest bosses, fetch chain) — using the raw
  // straight-line travel-to-stairs number would starve XP/gold progression by
  // firing the beeline too early. Once discovery has happened the base BT
  // already commits to the stairs interact, so the travel threshold is moot.
  const rawTravel = input.playerToStairsTravelMs;
  const travelEligible =
    input.staircaseUnlocked &&
    !input.staircaseDiscovered &&
    typeof rawTravel === 'number' &&
    Number.isFinite(rawTravel) &&
    rawTravel >= 0;
  const travelSafeMs = travelEligible ? (rawTravel as number) + PANIC_STAIRS_TRAVEL_SAFETY_MS : 0;
  const beelineThreshold = Math.max(PANIC_BEELINE_REMAINING_MS, travelSafeMs);
  // Preserve the legacy 120 s pressure ramp window: as the travel threshold
  // rises, the ramp-start floor rises with it so panic still starts ramping
  // ~120 s before the (elevated) beeline mark, not suddenly at t=beeline.
  const rampFloor = beelineThreshold + (PANIC_RAMP_START_REMAINING_MS - PANIC_BEELINE_REMAINING_MS);
  const rampStart = Math.max(PANIC_RAMP_START_REMAINING_MS, rampFloor);
  const panicSpan = Math.max(1, rampStart - beelineThreshold);
  const ramp = Math.max(0, Math.min(1, (rampStart - remainingMs) / panicSpan));
  const panic = Math.min(1, ramp * stairsMultiplier);
  const beeline = remainingMs <= beelineThreshold && !input.staircaseDiscovered;
  const travelBeelineActive =
    beeline && travelEligible && travelSafeMs > PANIC_BEELINE_REMAINING_MS;
  return {
    remainingMs,
    panic,
    beeline,
    stairsUnlocked: input.staircaseUnlocked,
    travelBeelineActive,
  };
}

interface NpcTarget extends WorldTarget {
  defId: string;
  interactionReason: AINpcInteractionActionValue;
}

interface TacticalOpportunityEnemySnapshot extends WorldTarget {
  hp: number;
}

export interface AINavigationDebug {
  pathWaypoints: TilePoint[];
  pathIndex: number;
  pathGoalKey: string | null;
  stuckFrames: number;
}

export interface AINpcMemoryDebug {
  discoveredNpcDefs: string[];
  talkedNpcDefs: string[];
  neededInteractionReasons: Record<string, string | null>;
}

export interface TacticalRunDebug {
  /**
   * Post-tick travel-steering run plan (`lastRunPlan`), estimated from the
   * decision the tree just committed. Drives predictive steering, not decisions.
   */
  runPlan: Floor1RunPlan | null;
  /**
   * Decision-time run plan estimated at poll-start. Currently always null
   * (reserved for future decision-mode arms). HUD/telemetry falls back to
   * `runPlan` when this is null.
   */
  decisionRunPlan: Floor1RunPlan | null;
  opportunities: TacticalOpportunityEvaluation | null;
}

/**
 * Breadth-first reachability flood over a 4-connected passable grid.
 *
 * Fills `depth[i]` with the BFS distance (in tiles) from `startIndex` to every
 * reachable tile, bounded at `maxDepth`; unreachable tiles keep the caller's
 * pre-filled sentinel (`-1`). `queue` is caller-owned scratch of length ≥ the
 * tile count. `startIndex` must be in-bounds and passable — every caller guards
 * that before calling, and this seeds `depth[startIndex] = 0`.
 *
 * Extracted verbatim from the two reachability paths — goal resolution in
 * {@link BehaviorTreeAI.computeReachableGoalTile} and explore-target sampling in
 * {@link BehaviorTreeAI.computeExploreReachabilityDepth} — so the shared
 * 4-connected expansion and `NAVIGATION_MAX_PATH_LENGTH` depth bound cannot
 * drift apart. The expansion order (+x, −x, +y, −y) is load-bearing for
 * determinism: it fixes the BFS distances, and downstream candidate ranking
 * (hence RNG consumption) depends on them, so it must not change.
 */
function floodReachabilityDepth(
  depth: Int32Array,
  queue: Int32Array,
  width: number,
  height: number,
  startIndex: number,
  maxDepth: number,
  passable: (tx: number, ty: number) => boolean,
): void {
  let head = 0;
  let tail = 0;
  depth[startIndex] = 0;
  queue[tail++] = startIndex;
  while (head < tail) {
    const index = queue[head++]!;
    const currentDepth = depth[index]!;
    if (currentDepth >= maxDepth) {
      continue;
    }
    const cx = index % width;
    const cy = (index - cx) / width;
    // 4-connected expansion mirrors findTilePath's topology-4 A*.
    if (cx + 1 < width && depth[index + 1] === -1 && passable(cx + 1, cy)) {
      depth[index + 1] = currentDepth + 1;
      queue[tail++] = index + 1;
    }
    if (cx - 1 >= 0 && depth[index - 1] === -1 && passable(cx - 1, cy)) {
      depth[index - 1] = currentDepth + 1;
      queue[tail++] = index - 1;
    }
    if (cy + 1 < height && depth[index + width] === -1 && passable(cx, cy + 1)) {
      depth[index + width] = currentDepth + 1;
      queue[tail++] = index + width;
    }
    if (cy - 1 >= 0 && depth[index - width] === -1 && passable(cx, cy - 1)) {
      depth[index - width] = currentDepth + 1;
      queue[tail++] = index - width;
    }
  }
}

/**
 * Behavior Tree AI that simulates human input.
 * Uses composable behavior tree nodes for decision-making.
 */
export class BehaviorTreeAI implements AIInputProvider {
  private readonly config: Required<AIConfig>;
  private readonly rng: SeededRandom;
  private readonly tree: BehaviorTree;
  private decision: AIDecision;
  private observedHostileEncounterRevision: number = 0;
  private hostileEncounterInvalidationCount: number = 0;
  private lastHostileEncounterInvalidationFrame: number = -1;
  private pathWaypoints: TilePoint[] = [];
  private pathIndex: number = 0;
  private pathGoalKey: string | null = null;
  private moveWedgeFrames: number = 0;
  private moveWedgeLastX: number = Number.NaN;
  private moveWedgeLastY: number = Number.NaN;
  private stuckFrames: number = 0;
  private lastPlayerX: number = 0;
  private lastPlayerY: number = 0;
  /** Smoothed output direction, updated each poll via {@link MOVE_SMOOTH_FACTOR}.
   * Initialized to (0, 0) at construction and persists across ordinary polls for
   * the lifetime of this AI instance. Hostile-encounter invalidation explicitly
   * zeroes it so a newly locked arena does not inherit pre-encounter steering. */
  private smoothMoveX: number = 0;
  private smoothMoveY: number = 0;
  /** Last travel-steering result (or null when steering did not drive the most
   * recent poll). Exposed via {@link getTravelSteeringDebug} for tests/telemetry. */
  private lastTravelSteering: TravelSteeringResult | null = null;
  private lastRunPlan: Floor1RunPlan | null = null;
  private merchantDecisionRunPlan: Floor1RunPlan | null = null;
  private merchantDecisionRunPlanFrame: number = -Infinity;
  /**
   * Cached deterministic player→stairs travel-time estimate (ms), refreshed
   * every {@link OBJECTIVE_TRAVEL_ASTAR_REFRESH_TICKS} BT polls (or when the
   * player crosses a tile) via {@link refreshPlayerToStairsTravelEstimate}.
   * Null when Floor-1 objective state is unavailable, when the staircase is
   * still locked, or when the discovery marker has already been reached (in
   * which case downstream code short-circuits to the legacy fixed-threshold
   * beeline). Used by {@link getCollapsePanicProfile} to phase-gate the panic
   * beeline threshold on the AI's perfect-world travel-time knowledge.
   */
  private lastPlayerToStairsTravelMs: number | null = null;
  /** Frame the travel estimate was last refreshed on; used with
   * {@link OBJECTIVE_TRAVEL_ASTAR_REFRESH_TICKS} to throttle A* recomputes. */
  private lastPlayerToStairsRefreshFrame: number = -Infinity;
  /** Player tile the travel estimate was last computed from; if the player
   * has stepped to a new tile we refresh immediately even when the frame
   * throttle would otherwise defer. */
  private lastPlayerToStairsTileX: number | null = null;
  private lastPlayerToStairsTileY: number | null = null;
  private lastTacticalOpportunityEvaluation: TacticalOpportunityEvaluation | null = null;
  private tacticalTravelOwnsLoot: boolean = false;
  /**
   * Whether the AI is currently committed to a retreat. Latched so the retreat
   * condition can apply hysteresis (see {@link RETREAT_HYSTERESIS_MULT}) instead
   * of re-deciding every frame at the danger-radius boundary.
   */
  /**
   * Track the previous frame's arena lock-in so the AI emits a single-shot
   * log line on enter/exit (avoids per-frame spam while locked) and the
   * blackboard payload stays stable across ticks.
   *
   * `null` = not in an arena lock-in last frame. When set, it holds the
   * source spawner eid or the boss eid so the "still locked in on X" state
   * can be recognized cheaply.
   */
  private lastArenaLockinEid: number | null = null;
  private lastArenaLockinKind: 'spawner' | 'boss' | null = null;

  private retreating: boolean = false;
  /**
   * Cached kite-retreat destination (world center of a reachable open tile) plus
   * the frame it was chosen. Recomputing the arc scan + A* verification every
   * frame is wasteful and jittery, so {@link pickRetreatTarget} is throttled: the
   * target is only refreshed when it is null, when the player has arrived near it,
   * or every {@link RETREAT_REPICK_INTERVAL_FRAMES}. Reset whenever retreat ends.
   */
  private retreatTargetX: number | null = null;
  private retreatTargetY: number | null = null;
  private retreatRepickFrame: number = 0;
  private retreatThreatEid: number | null = null;
  private rangedEmergencyRetreating: boolean = false;
  /**
   * Persistent melee-kite orbit direction (+1 / -1) and the frame it was last
   * flipped. Held across polls so the player circles the enemy steadily instead
   * of jittering; reversed every {@link KITE_FLIP_FRAMES} frames so it juke-dodges
   * and never grinds into a single wall.
   */
  private kiteOrbitSign: 1 | -1 = 1;
  private kiteSignFrame: number = 0;
  private rangedDefensiveSpacing: boolean = false;
  private readonly ignoredLootUntilFrame = new Map<number, number>();
  private readonly ignoredEnemyUntilFrame = new Map<number, number>();
  private engageNoProgressFrames: number = 0;
  /** Per-eid best {distance, hp} seen while tracking that enemy during ENGAGE. */
  private readonly engageBaselinesByEid = new Map<
    number,
    { bestDistance: number; bestHp: number }
  >();
  private collectDwellActive: boolean = false;
  private collectDwellAnchorX: number = 0;
  private collectDwellAnchorY: number = 0;
  private collectDwellFrames: number = 0;
  private readonly exploreDwell = new DwellTracker(EXPLORE_DWELL_ESCAPE_FT, EXPLORE_DWELL_FRAMES);
  /**
   * Frame after which a suppressed position-based progress goal (Tutorial Goon,
   * Shopkeeper, boss room, staircase…) becomes eligible again. Set by
   * {@link updateExploreWatchdog} when a dwell-watchdog fires on a non-enemy EXPLORE
   * target so the BT falls through to Hunt/Engage instead of freezing on the same
   * unreachable position forever.
   */
  private progressGoalSuppressedUntilFrame: number = 0;
  private progressGoalSuppressionSource: AIProgressSuppressionSourceValue | null = null;
  private pendingSuppressedProgressNavDebug: AISuppressedProgressNavDebug | null = null;
  /** True once FOV has exposed at least one tile this run (perception initialized). */
  private hasPerceptionData = false;
  /** Reused per-tile BFS visited scratch for {@link findNearestFrontier}; sized to the floor. */
  private frontierBfsVisited: Uint8Array | null = null;
  /** Reused BFS depth scratch for {@link pickExploreTarget} reachability checks. */
  private exploreReachabilityDepth: Int32Array | null = null;
  /** Reused queue scratch for {@link pickExploreTarget} reachability flood. */
  private exploreReachabilityQueue: Int32Array | null = null;
  private globalDwellActive: boolean = false;
  private globalDwellAnchorX: number = 0;
  private globalDwellAnchorY: number = 0;
  private globalDwellFrames: number = 0;
  private globalDwellBestEnemyDist: number = Number.POSITIVE_INFINITY;
  private globalDwellBestEnemyHp: number = Number.POSITIVE_INFINITY;
  private questProgressActive: boolean = false;
  private questProgressBestScore: number = 0;
  private questProgressStallFrames: number = 0;
  private readonly targetReachableCache = new Map<number, { frame: number; reachable: boolean }>();
  private readonly discoveredNpcDefs = new Set<string>();
  private readonly talkedNpcDefs = new Set<string>();
  private readonly neededInteractionReasonByNpc = new Map<string, string | null>();
  /**
   * Door-aware passability predicate, rebuilt once per {@link poll} so A* can
   * plan routes through closed-but-openable doors while still treating
   * locked-unsatisfied doors as walls. `null` until the first poll.
   */
  private doorAwarePassable: ((x: number, y: number) => boolean) | null = null;
  /**
   * One-slot cache for the resolved goal tile. `resolveReachableGoalTile` runs
   * at least one full A* search per call, so calling it every frame even when the
   * raw goal tile hasn't changed wastes significant CPU. The map topology is
   * static for the lifetime of a floor, so the resolved tile for a given raw goal
   * tile is stable and safe to cache across frames.
   */
  private resolvedGoalCache: { rawKey: string; resolved: TilePoint } | null = null;
  /**
   * Per-floor cache for BFS-derived NPC interaction anchors. Keyed by npcEid.
   * The anchor is stable while the floor map and passability don't change, so
   * we compute it once and reuse every AI tick instead of re-running the full
   * BFS flood fill each frame.
   * `null` value = computed but no reachable anchor found (also cached to avoid
   * redundant BFS retries).
   */
  private readonly npcInteractionAnchorCache = new Map<number, { x: number; y: number } | null>();
  /**
   * Cross-poll memo for {@link resolveReachableGoalTile}. That helper runs up to
   * O(radius^2) full A* searches in its fallback branch and the AI calls it every
   * poll while navigating, so re-deriving the same answer each frame dominated
   * headless wall time. The resolved tile is a pure function of (start tile, goal
   * tile, radius) and the door-aware passable graph, so it is safe to cache while
   * {@link navEpoch} (floor + blocked-door signature) is unchanged.
   */
  private readonly resolveGoalMemo = new Map<string, TilePoint>();
  private resolveGoalMemoEpoch = -1;
  /**
   * Monotonic navigation epoch. Bumped by {@link refreshDoorNavigation} only when
   * the passable graph could have changed (floor swap or a door flipping between
   * navigation-blocked and passable), which is exactly when cached reachability
   * results must be discarded.
   */
  private navEpoch = 0;
  private navSignature: string | null = null;
  /**
   * The chosen route head stays committed while the navigation graph and known
   * objective state are unchanged. Door, quest, inventory, boss, and optional
   * intent transitions change the key and trigger an immediate exact replan.
   */
  private floor1MiddleChainCache: {
    navEpoch: number;
    stateKey: string;
    goalId: string | null;
  } | null = null;
  /** Cached result of {@link planFloor1ObjectiveRoute}, keyed on quest-state + budget bucket + speed.
   * Exact timing and segment travel are recomputed per frame from the live snapshot. Cleared on {@link reset}. */
  private runPlanCache: ReturnType<typeof planFloor1ObjectiveRoute> | null = null;
  private runPlanCacheKey: string | null = null;
  /**
   * Locked doors the AI is currently aware of, keyed by door entity. Populated
   * from {@link getNavigationBlockedDoors} each poll and pruned when a door's
   * unlock condition is satisfied, so it reflects "doors I know I cannot yet
   * pass, and what each needs".
   */
  private readonly knownLockedDoors = new Map<number, AILockedDoorMemory>();
  /**
   * Opportunistic loot-detour pull vector set by Track B's OpportunisticCollect
   * node each poll. Reset to (0,0) before tree.tick() and blended into the final
   * move vector in poll() with {@link AIConfig.collectPullWeight}.
   */
  private opportunisticPullX: number = 0;
  private opportunisticPullY: number = 0;
  /**
   * Enemy-farm pull vector set by Track B's OpportunisticFarm node each poll.
   * Decoupled from the loot pull so it rides its own {@link AIConfig.farmPullWeight}
   * (default 0) — re-enabling loot detours must never silently re-enable enemy
   * seeking. Reset to (0,0) before tree.tick().
   */
  private farmPullX: number = 0;
  private farmPullY: number = 0;
  /**
   * Dodge vector set by Track B's OpportunisticDodge node each poll.
   * Reset to (0,0) before tree.tick() and blended in with {@link AIConfig.dodgeWeight}.
   */
  private dodgeVecX: number = 0;
  private dodgeVecY: number = 0;
  // Previous fused heading (unit vector) — read by the RISK_REWARD_FUSED scorer
  // for its continuity bonus to reduce oscillation, and written at the end of
  // each fused poll. Dormant in LEGACY pathing. Reset per run in {@link reset}.
  private prevFusedDirX: number = 0;
  private prevFusedDirY: number = 0;
  /**
   * When true, {@link computeRiskRewardFusedHeading} records a per-poll
   * {@link FusedHeadingDebug} snapshot of every scored candidate for the lab
   * visualizer. Default OFF: the headless runner / A/B sweep never sets it, so
   * that path allocates nothing extra and stays byte-identical to the validated
   * gate. Only ever populated in RISK_REWARD_FUSED mode (the method is dead in
   * LEGACY), and the snapshot is never read back into any decision.
   */
  public fusedDebugCapture: boolean = false;
  private fusedDebug: FusedHeadingDebug | null = null;
  private acceptedQuestCount: number = 0;
  /**
   * Quest-giver detour hysteresis. Once {@link withQuestGiverDetour} ACCEPTS a
   * detour to a quest NPC, its entity id is latched here and re-derived directly
   * each poll (bypassing {@link findNearestRelevantNpc}'s `playerInSafeRoom`
   * filter) so the detour survives the safe-room-mouth boundary flicker instead
   * of flip-flopping the selected objective every frame. Released when the NPC is
   * reached/handled/gone, when the relaxed cap is exceeded, when progress-goal
   * suppression is active, or by the no-progress abandon valve below. `null` when
   * no detour is committed; reset per run in {@link reset}.
   */
  private committedDetourNpcEid: number | null = null;
  /** Smallest player→committed-NPC distance seen since committing; drives the
   * no-progress abandon valve. `+Infinity` while no detour is committed. */
  private committedDetourBestDistance: number = Number.POSITIVE_INFINITY;
  /** Consecutive polls with no improvement toward the committed NPC. Once it
   * exceeds {@link QUEST_GIVER_DETOUR_ABANDON_FRAMES} the CURRENT commitment is
   * released. Note this only drops the latch — it does not blacklist the NPC, so
   * if that NPC is still the nearest on-path candidate under the strict base cap,
   * Block D may re-select it on a later poll, exactly as the pre-hysteresis
   * baseline did. The valve therefore bounds a single sticky commitment, not the
   * runner's total time near an unreachable NPC. */
  private committedDetourNoProgressFrames: number = 0;
  /**
   * NPC-approach threat-clear no-progress valve. While a nearby non-projectile
   * threat is blocking the path to a quest NPC, we re-enter ENGAGE to clear it
   * each poll — but if the player→NPC distance stops improving for
   * {@link NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES} consecutive polls (even as
   * the specific blocking enemy rotates via the per-enemy ENGAGE_GIVEUP_FRAMES
   * watchdog), we latch a bypass so the AI walks toward the NPC directly
   * instead of livelocking on threat-clear forever. `null` when no NPC is
   * currently being tracked; reset per run in {@link reset}.
   */
  private npcApproachThreatNpcEid: number | null = null;
  /** Smallest player→NPC distance seen since {@link npcApproachThreatNpcEid}
   * was latched; drives the no-progress bypass above. `+Infinity` while no
   * NPC is being tracked. */
  private npcApproachThreatBestDistance: number = Number.POSITIVE_INFINITY;
  /** Consecutive polls with no improvement toward the tracked NPC. */
  private npcApproachThreatNoProgressFrames: number = 0;
  /** Entity id of the NPC for which the no-progress bypass has latched. While
   * this matches {@link npcApproachThreatNpcEid}, threat-clear ENGAGE is
   * bypassed until the nearby-threat gate exits and resets tracking. `null`
   * when no bypass is active. */
  private npcApproachThreatBypassEid: number | null = null;
  /** True when Track A reached Progress during this poll. Used to clear stale
   * NPC threat-clear bypass state if higher-priority nodes pre-empt Progress. */
  private npcApproachThreatProgressEvaluatedThisPoll: boolean = false;
  /**
   * Latched safe-room egress waypoint. While LeaveSafeRoom is active we keep a
   * single reachable world target until the player exits the safe room, so
   * threat-relative ENGAGE pursuit cannot flip the heading each frame.
   */
  private safeRoomEgressTargetX: number | null = null;
  private safeRoomEgressTargetY: number | null = null;
  private safeRoomEgressThreatEid: number | null = null;
  private safeRoomEgressOutsideFrames: number = 0;
  private safeRoomEgressBestDistanceFt: number = Number.POSITIVE_INFINITY;
  private safeRoomEgressNoProgressFrames: number = 0;
  private safeRoomEgressActiveFrames: number = 0;
  private safeRoomEgressSuppressFrames: number = 0;
  private floor2HuntMap: FloorMap | null = null;
  private floor2HuntFamilyId: FamilyId | null = null;
  private floor2HuntPatrolIndex: number = 0;
  private floor2HuntPatrolTarget: TilePoint | null = null;
  private floor2HuntLastKillCount: number = 0;
  private floor2HuntLastProgressFrame: number = 0;
  private floor2HuntCadenceStartFrame: number = 0;
  private floor2HuntHandledSuppressionUntilFrame: number = 0;
  private readonly floor2HuntPatrolTiles = new Map<string, TilePoint[]>();
  private xpCleanupMode: 'local' | 'exit' | null = null;
  private xpCleanupAnchorX: number = 0;
  private xpCleanupAnchorY: number = 0;
  private xpCleanupStartFrame: number = 0;
  private xpCleanupCooldownUntilFrame: number = 0;
  private xpCleanupCombatWindowUntilFrame: number = -1;

  constructor(config: AIConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rng = new SeededRandom(this.config.seed);
    this.decision = {
      state: AIState.EXPLORE,
      targetEid: null,
      targetX: null,
      targetY: null,
      reason: 'Initializing',
      npcInteraction: null,
      debug: null,
    };

    // Build the behavior tree
    this.tree = this.buildTree();
  }

  /**
   * Build the behavior tree structure.
   *
   * Root is a BTParallel(OBSERVE) wrapping two independent tracks that tick
   * every frame:
   *
   * - **Track A** (Movement Goal): the exclusive priority Selector that picks
   *   one movement target per frame. Retreat > ArenaLockin > Interact >
   *   Progress > LeaveSafeRoom > Engage > Collect > Hunt > Explore. Owns
   *   `this.decision` and `state.moveX/moveY`. See ADR 0045 for the
   *   arena-lockin priority-slot decision.
   *
   * - **Track B** (Opportunistic): a side-effectful parallel that runs every
   *   frame regardless of Track A's outcome and writes into
   *   `this.opportunisticPullX/Y` and `this.dodgeVecX/Y`. poll() blends these
   *   vectors into the Track A direction with configurable weights
   *   (`collectPullWeight`, `dodgeWeight`) so the player curves toward nearby
   *   loot and away from fast-closing enemies while still pursuing its primary
   *   objective.
   */
  private buildTree(): BehaviorTree {
    const root = parallel(
      'AI Root',
      BTParallelPolicy.OBSERVE,
      // Track A: exclusive priority selector (original logic, unchanged)
      selector(
        'Track A: Movement Goal',
        // Priority 1: Retreat when low health
        this.buildRetreatBehavior(),
        // Priority 1.5: Prioritize objective when locked inside a spawner
        // arena or boss room — see `arena-lockin.ts` + ADR 0045.
        this.buildArenaLockinBehavior(),
        // Priority 2: Interact with nearby NPCs
        this.buildInteractBehavior(),
        // Priority 2.5: bounded post-combat / final-exit XP cleanup.
        this.buildPriorityXpCleanupBehavior(),
        // Priority 3: Seek progression objectives.
        this.buildProgressBehavior(),
        // Priority 3.5: Leave a safe room when enemies are present.
        this.buildLeaveSafeRoomBehavior(),
        // Priority 4: Engage enemies
        this.buildEngageBehavior(),
        // Priority 5: Collect nearby loot
        this.buildCollectBehavior(),
        // Priority 6: Close distance to nearby enemies before wandering off
        this.buildHuntBehavior(),
        // Priority 7: Explore when nothing else to do
        this.buildExploreBehavior(),
      ),
      // Track B: opportunistic layer — side-effectful, never gates the tree
      this.buildOpportunisticLayer(),
    );

    return new BehaviorTree(root);
  }

  /**
   * Retreat behavior: flee when health is low AND a threat is actually nearby.
   *
   * Crucially, low health alone does NOT trigger a retreat. There is no passive
   * health regeneration, so if the AI retreated whenever it was hurt it would
   * latch into a do-nothing RETREAT forever (standing still, never healing,
   * never finishing objectives). By requiring a living, reachable enemy within
   * `retreatDangerRadius`, a wounded-but-safe AI falls through to its progression
   * behaviors (interact / collect / explore) and keeps clearing the floor.
   */
  /** Clear the retreat latch and discard any cached kite target. */
  private endRetreat(world?: GameWorld): void {
    if (
      world &&
      this.retreating &&
      this.retreatThreatEid !== null &&
      this.getPlayerHealthFraction(world) < this.config.retreatThreshold
    ) {
      this.ignoredEnemyUntilFrame.set(
        this.retreatThreatEid,
        world.frameCount + Math.max(RETREAT_REPICK_INTERVAL_FRAMES * 4, 60),
      );
    }
    this.retreating = false;
    this.rangedEmergencyRetreating = false;
    this.retreatTargetX = null;
    this.retreatTargetY = null;
    this.retreatThreatEid = null;
  }

  private buildRetreatBehavior(): BTNode {
    return sequence(
      'Retreat',
      condition('Low Health Under Threat', (ctx) => {
        const activeWeapon = getActiveWeapon(ctx.world);
        const criticallyLow = ctx.healthPercent < this.config.retreatThreshold;
        const rangedEmergency =
          activeWeapon !== undefined &&
          isProjectileWeaponType(activeWeapon.weaponType) &&
          ctx.healthPercent < RANGED_DEFENSIVE_HP_FRACTION &&
          !criticallyLow;
        if (!criticallyLow && !rangedEmergency) {
          this.endRetreat(ctx.world);
          return false;
        }

        // An enemy ignored for target selection is still physically dangerous.
        // Retreat must sense it if it closes again, otherwise a low-health player
        // resumes progression while the temporarily ignored attacker lands free hits.
        const threat = this.findNearestEnemy(
          ctx.world,
          ctx.playerX,
          ctx.playerY,
          this.config.scanRadius,
          true,
        );
        if (threat) {
          const attackRange = ctx.world.stores.enemyBehavior.attackRange[threat.eid] ?? 0;
          const retreatEscapeRadius = this.config.retreatDangerRadius * RETREAT_HYSTERESIS_MULT;
          if (attackRange > retreatEscapeRadius) {
            // Backing to the retreat hysteresis edge cannot disengage a shooter
            // whose real attack range extends beyond it. Radial retreat then
            // alternates with radial re-approach on the same projectile line.
            // Let engagement own the response so melee can strafe-close instead.
            this.endRetreat(ctx.world);
            return false;
          }
        }
        // Hysteresis: an enemy must close to within retreatDangerRadius to START
        // a retreat, but the AI keeps retreating until the gap exceeds
        // retreatDangerRadius * RETREAT_HYSTERESIS_MULT. This stops the per-frame
        // RETREAT<->EXPLORE flip-flop seen when an enemy hovers at the boundary.
        const radius = this.retreating
          ? this.rangedEmergencyRetreating && !criticallyLow
            ? this.config.rangedSafeDistance
            : this.config.retreatDangerRadius * RETREAT_HYSTERESIS_MULT
          : rangedEmergency
            ? CONTACT_SAFE_ORBIT_FT
            : this.config.retreatDangerRadius;
        if (!threat || threat.distance > radius) {
          this.endRetreat(ctx.world);
          return false;
        }
        this.retreating = true;
        this.rangedEmergencyRetreating = rangedEmergency;
        // Arm the defensive-spacing latch so that when this emergency retreat
        // releases (enemy backs past rangedSafeDistance) planRangedEngagement
        // immediately holds the wider 10-ft orbit rather than closing back to
        // the 6-ft healthy orbit until a pressure threat re-enters the window.
        if (rangedEmergency) {
          this.rangedDefensiveSpacing = true;
        }
        this.retreatThreatEid = threat.eid;
        ctx.blackboard['retreatThreat'] = threat;
        ctx.blackboard['rangedEmergencyRetreat'] = rangedEmergency;
        return true;
      }),
      action('Set Retreat State', (ctx) => {
        const threat = ctx.blackboard['retreatThreat'] as WorldTarget | undefined;
        const rangedEmergency = ctx.blackboard['rangedEmergencyRetreat'] === true;
        this.decision.state = AIState.RETREAT;
        this.decision.reason = rangedEmergency
          ? `Wounded projectile user under contact pressure (${(ctx.healthPercent * 100).toFixed(0)}% health)`
          : `Low health (${(ctx.healthPercent * 100).toFixed(0)}%) near threat`;
        this.decision.targetEid = null;
        if (!threat) {
          this.retreatTargetX = null;
          this.retreatTargetY = null;
          this.decision.targetX = ctx.playerX;
          this.decision.targetY = ctx.playerY;
          return BTStatus.SUCCESS;
        }
        // Kite toward reachable open space rather than fleeing straight away from
        // the nearest threat. The naive away-vector points into the wall when the
        // player is cornered, so navigation finds no reachable tile and the AI
        // wiggles in place until the swarm kills it. pickRetreatTarget scans an
        // arc and A*-verifies, so the chosen tile is always actually reachable.
        // Throttle the scan: only re-pick when we have no target, have arrived
        // near the current one, or the re-pick interval has elapsed.
        const arrived =
          this.retreatTargetX !== null &&
          this.retreatTargetY !== null &&
          Math.hypot(this.retreatTargetX - ctx.playerX, this.retreatTargetY - ctx.playerY) <=
            RETREAT_REPICK_ARRIVE_FT;
        const stale =
          ctx.world.frameCount - this.retreatRepickFrame >= RETREAT_REPICK_INTERVAL_FRAMES;
        if (this.retreatTargetX === null || this.retreatTargetY === null || arrived || stale) {
          const target = this.pickRetreatTarget(ctx.world, ctx.playerX, ctx.playerY, threat);
          this.retreatTargetX = target.x;
          this.retreatTargetY = target.y;
          this.retreatRepickFrame = ctx.world.frameCount;
        }
        this.decision.targetX = this.retreatTargetX;
        this.decision.targetY = this.retreatTargetY;
        return BTStatus.SUCCESS;
      }),
    );
  }

  /**
   * Choose a kite-retreat destination: the most open tile the player can
   * actually A*-reach, fleeing the swarm centroid instead of a single threat.
   *
   * Sampling an arc (±120° around the away-from-centroid base angle) at two
   * distances and scoring each candidate by its distance to the nearest enemy
   * means corners — where every nearby tile hugs a wall and sits close to the
   * pursuing pack — score poorly and reachable open lanes score well. We
   * A*-verify the highest-scoring candidates in order and return the first that
   * is genuinely reachable, falling back to the legacy away-vector if the floor
   * map is missing or nothing verifies.
   */
  private pickRetreatTarget(
    world: GameWorld,
    playerX: number,
    playerY: number,
    threat: WorldTarget,
  ): { x: number; y: number } {
    const awayFallback = (): { x: number; y: number } => {
      const awayX = playerX - threat.x;
      const awayY = playerY - threat.y;
      const len = Math.hypot(awayX, awayY) || 1;
      return {
        x: playerX + (awayX / len) * this.config.scanRadius,
        y: playerY + (awayY / len) * this.config.scanRadius,
      };
    };

    const floorMap = world.floorMap;
    if (!floorMap) {
      return awayFallback();
    }

    // Gather nearby live enemies for the flee centroid and open-space scoring.
    const enemyPositions: Array<{ x: number; y: number }> = [];
    let centroidX = 0;
    let centroidY = 0;
    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      if (eid === undefined) continue;
      if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      if (!this.canPerceiveWorldPosition(world, ex, ey)) continue;
      if (Math.hypot(ex - playerX, ey - playerY) > RETREAT_THREAT_SCAN_FT) continue;
      enemyPositions.push({ x: ex, y: ey });
      centroidX += ex;
      centroidY += ey;
    }

    let baseAngle: number;
    if (enemyPositions.length > 0) {
      centroidX /= enemyPositions.length;
      centroidY /= enemyPositions.length;
      baseAngle = Math.atan2(playerY - centroidY, playerX - centroidX);
    } else {
      baseAngle = Math.atan2(playerY - threat.y, playerX - threat.x);
    }

    const startTile = floorMap.worldToTile(playerX, playerY);
    const candidates: Array<{ x: number; y: number; score: number }> = [];
    for (const offset of RETREAT_ARC_OFFSETS_RAD) {
      const angle = baseAngle + offset;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      for (const mult of RETREAT_DISTANCE_MULTS) {
        const dist = this.config.scanRadius * mult;
        const wx = playerX + dirX * dist;
        const wy = playerY + dirY * dist;
        const tile = floorMap.worldToTile(wx, wy);
        if (tile.x === startTile.x && tile.y === startTile.y) continue;
        const passable = this.doorAwarePassable
          ? this.doorAwarePassable(tile.x, tile.y)
          : floorMap.tileMap.isPassable(tile.x, tile.y);
        if (!passable) continue;
        let minEnemyDist = Number.POSITIVE_INFINITY;
        for (const enemy of enemyPositions) {
          const d = Math.hypot(enemy.x - wx, enemy.y - wy);
          if (d < minEnemyDist) minEnemyDist = d;
        }
        candidates.push({ x: wx, y: wy, score: minEnemyDist });
      }
    }

    // Most open candidates first; A*-verify in score order and take the first
    // that is genuinely reachable. The verification budget keeps the scan cheap.
    candidates.sort((a, b) => b.score - a.score);
    let verifications = 0;
    for (const candidate of candidates) {
      if (verifications >= RETREAT_MAX_PATH_VERIFICATIONS) break;
      const goalTile = floorMap.worldToTile(candidate.x, candidate.y);
      verifications += 1;
      const path = findTilePath(floorMap, startTile, goalTile, this.groundPathOptions());
      if (path.length > 1) {
        const center = floorMap.tileToWorld(goalTile.x, goalTile.y);
        return { x: center.x, y: center.y };
      }
    }

    return awayFallback();
  }

  /**
   * Arena lock-in behavior (Priority 1.5): when the player is trapped in a
   * spawner arena (fence ring or sealed room) or a Floor-1 boss room, force
   * the AI to target the spawner / boss instead of falling through to
   * Interact / Progress / Explore — otherwise the AI wanders toward stale
   * chain-plan targets (e.g. the far-away staircase) while sealed inside a
   * room it cannot leave.
   *
   * Retreat (Priority 1) still takes precedence: low-HP-under-threat is
   * life-critical and drops out of arena lock-in only long enough to kite
   * to a safe tile. Because the arena also traps the threats, the kite is
   * bounded and returns to lock-in as soon as HP recovers.
   *
   * Detection lives in `arena-lockin.ts`; the BT node here is purely a
   * priority + blackboard/logging shim so the state machine stays inspect-
   * able.
   */
  private buildArenaLockinBehavior(): BTNode {
    return sequence(
      'ArenaLockin',
      condition('Player Locked In Arena', (ctx) => {
        const target = detectArenaLockin(ctx.world, ctx.playerX, ctx.playerY);
        // Always publish the blackboard snapshot so labs/tests can inspect
        // the transition from a locked -> unlocked frame without the node
        // having to fire.
        ctx.blackboard['arenaLockin'] = {
          active: target !== null,
          kind: target?.kind ?? null,
          targetEid: target?.eid ?? null,
        };
        if (target === null) {
          if (this.lastArenaLockinEid !== null) {
            logger.debug(
              `AI arena lock-in cleared (${this.lastArenaLockinKind ?? 'unknown'} ${String(
                this.lastArenaLockinEid,
              )})`,
            );
          }
          this.lastArenaLockinEid = null;
          this.lastArenaLockinKind = null;
          return false;
        }
        if (this.lastArenaLockinEid !== target.eid || this.lastArenaLockinKind !== target.kind) {
          logger.debug(
            `AI arena lock-in engaged: ${target.kind} eid=${String(target.eid)} at ` +
              `(${target.x.toFixed(1)}, ${target.y.toFixed(1)})`,
          );
        }
        this.lastArenaLockinEid = target.eid;
        this.lastArenaLockinKind = target.kind;
        ctx.blackboard['arenaLockinTarget'] = target;
        return true;
      }),
      action('Set Arena Lock-In State', (ctx) => {
        const target = ctx.blackboard['arenaLockinTarget'] as ArenaLockinTarget;
        const dxTarget = target.x - ctx.playerX;
        const dyTarget = target.y - ctx.playerY;
        const targetDistance = Math.hypot(dxTarget, dyTarget) || 0;

        // Add-clearing: for a *boss* lock-in (bosses have finite adds and
        // move), interrupt to engage a nearby add first — this mirrors
        // Progress's "clear-nearby-threat before NPC interaction" pattern
        // (~line 1042). For a *spawner* lock-in the adds are Sisyphean —
        // the spawner keeps producing them at ~2s intervals in defensive
        // mode, so time spent on adds is time the spawner spends adding
        // more. The safest strategy is to burn the spawner to zero first;
        // its death queues an on-death monarch pool anyway (registry.ts
        // rats-nest.onDeath), which the surviving adds get killed
        // alongside once the fence lowers and normal Engage resumes.
        const engageRadius = this.getEngageRadius(ctx.world);
        // Exclude the boss target so an exact-distance tie between boss and add
        // always resolves to the add when defensive pressure applies. Without
        // this exclusion, `findNearestEnemy` could return the boss itself (lower
        // eid wins the tie-break sort), making `defensiveAddPressure` false and
        // silently skipping the add override.
        const nearestAdd =
          target.kind === 'boss'
            ? this.findNearestEnemy(
                ctx.world,
                ctx.playerX,
                ctx.playerY,
                this.config.scanRadius,
                false,
                target.eid,
              )
            : null;
        const defensiveAddPressure =
          ctx.healthPercent < ARENA_LOCKIN_DEFENSIVE_HP_FRACTION &&
          nearestAdd !== null &&
          nearestAdd.distance <= ARENA_LOCKIN_ADD_PRESSURE_FT;
        if (
          target.kind === 'boss' &&
          nearestAdd !== null &&
          nearestAdd.distance <= engageRadius &&
          (defensiveAddPressure ||
            nearestAdd.distance + ARENA_LOCKIN_ADD_HYSTERESIS_FT < targetDistance)
        ) {
          const plan = this.planEngagement(ctx.world, ctx.playerX, ctx.playerY, nearestAdd);
          this.decision.state = AIState.ENGAGE;
          this.decision.targetEid = nearestAdd.eid;
          this.decision.targetX = plan.targetX;
          this.decision.targetY = plan.targetY;
          this.decision.reason = `Boss-room lock-in — clearing add ${String(nearestAdd.eid)} before boss`;
          return BTStatus.SUCCESS;
        }

        // Route the objective through the appropriate movement plan:
        //   - Spawners are stationary structures, so orbit/kite is wasted
        //     motion — walk straight in and let the weapon auto-fire once
        //     the strike gate is reached. This is critical for melee: the
        //     spawner's `defensive` mode floods the arena with adds every
        //     2s, so any second spent orbiting a stationary target is a
        //     second the swarm grows.
        //   - Bosses move, so run `planEngagement` (kite/strafe) exactly
        //     like normal Engage would.
        this.decision.state = AIState.ENGAGE;
        this.decision.targetEid = target.eid;
        if (target.kind === 'boss') {
          const bossWt: WorldTarget = {
            eid: target.eid,
            x: target.x,
            y: target.y,
            distance: targetDistance,
          };
          const plan = this.planEngagement(ctx.world, ctx.playerX, ctx.playerY, bossWt);
          this.decision.targetX = plan.targetX;
          this.decision.targetY = plan.targetY;
          this.decision.reason = `Boss-room lock-in — ${plan.reason} (boss ${String(target.eid)})`;
        } else {
          this.decision.targetX = target.x;
          this.decision.targetY = target.y;
          this.decision.reason = `Arena lock-in — attacking spawner ${String(target.eid)} at ${targetDistance.toFixed(1)}ft`;
        }
        return BTStatus.SUCCESS;
      }),
    );
  }

  /**
   * Interact behavior: talk to nearby NPCs.
   */
  private buildInteractBehavior(): BTNode {
    return sequence(
      'Interact',
      condition('NPC Nearby', (ctx) => {
        const nearest = this.findNearestRelevantNpc(
          ctx.world,
          ctx.playerEid,
          ctx.playerX,
          ctx.playerY,
        );
        if (nearest && nearest.distance < NPC_INTERACTION_RADIUS_FT) {
          ctx.blackboard['nearestNpc'] = nearest;
          return true;
        }
        return false;
      }),
      action('Set Interact State', (ctx) => {
        const nearest = ctx.blackboard['nearestNpc'] as NpcTarget;
        this.decision.state = AIState.INTERACT;
        this.decision.targetEid = nearest.eid;
        this.decision.targetX = nearest.x;
        this.decision.targetY = nearest.y;
        this.talkedNpcDefs.add(nearest.defId);
        this.decision.reason = `Interacting with ${nearest.defId} (${nearest.interactionReason}) at ${nearest.distance.toFixed(0)}ft`;
        this.decision.npcInteraction = {
          npcEid: nearest.eid,
          action: nearest.interactionReason,
          allowWhileExploring: false,
        };
        return BTStatus.SUCCESS;
      }),
    );
  }

  /**
   * Progress behavior: move toward the next quest-critical objective.
   */
  private buildProgressBehavior(): BTNode {
    return sequence(
      'Progress',
      condition('Progress Objective Available', (ctx) => {
        this.npcApproachThreatProgressEvaluatedThisPoll = true;
        const target = this.findProgressObjective(
          ctx.world,
          ctx.playerEid,
          ctx.playerX,
          ctx.playerY,
        );
        if (target) {
          ctx.blackboard['progressTarget'] = target;
          return true;
        }

        this.resetNpcApproachThreatTracking();
        return false;
      }),
      action('Set Progress State', (ctx) => {
        const target = ctx.blackboard['progressTarget'] as ProgressTarget;
        const targetIsNpc =
          target.eid >= 0 &&
          entityExists(ctx.world.ecs, target.eid) &&
          hasComponent(ctx.world.ecs, target.eid, Npc);
        // If a quest NPC is the current progress objective but a nearby threat is
        // already inside engagement range, clear the threat first instead of
        // pathing straight through it toward the NPC.
        const tutorialAccepted = ctx.world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID);
        if (
          targetIsNpc &&
          tutorialAccepted &&
          !this.isFloor2IntroductionPending(ctx.world) &&
          target.distance > NPC_INTERACTION_RADIUS_FT
        ) {
          const nearestEnemy = this.findNearestEnemy(ctx.world, ctx.playerX, ctx.playerY);
          const npcThreatRadius = Math.min(
            this.getEngageRadius(ctx.world),
            NPC_APPROACH_THREAT_RADIUS_FT,
          );
          if (nearestEnemy && nearestEnemy.distance <= npcThreatRadius) {
            const weapon = getActiveWeapon(ctx.world);
            const projectileWeapon = weapon ? isProjectileWeaponType(weapon.weaponType) : false;
            if (projectileWeapon) {
              // Auto-fire handles projectile weapons at range, so keep travelling
              // toward the NPC instead of re-entering ENGAGE — fall through to the
              // direct-approach path below.
              this.resetNpcApproachThreatTracking();
            } else if (this.shouldClearThreatBeforeNpc(target)) {
              const plan = this.planEngagement(ctx.world, ctx.playerX, ctx.playerY, nearestEnemy);
              this.decision.state = AIState.ENGAGE;
              this.decision.targetEid = nearestEnemy.eid;
              this.decision.targetX = plan.targetX;
              this.decision.targetY = plan.targetY;
              this.decision.reason = `Clearing nearby threat before NPC interaction — ${plan.reason}`;
              return BTStatus.SUCCESS;
            }
          } else {
            this.resetNpcApproachThreatTracking();
          }
        } else {
          this.resetNpcApproachThreatTracking();
        }
        // If this progress goal points at a living enemy (e.g. hunting quest mobs,
        // farming the swarm for charm gold), reuse the shared engagement kite so
        // the AI strafes and holds a safe strike distance instead of walking
        // straight onto the enemy and trading blows. Position objectives and
        // non-enemy entities (gold piles, NPCs) keep the direct-approach path.
        const enemyTarget = this.progressTargetAsEnemy(ctx.world, target, ctx.playerX, ctx.playerY);
        if (enemyTarget) {
          const plan = this.planEngagement(ctx.world, ctx.playerX, ctx.playerY, enemyTarget);
          this.decision.state = AIState.ENGAGE;
          this.decision.targetEid = enemyTarget.eid;
          this.decision.targetX = plan.targetX;
          this.decision.targetY = plan.targetY;
          this.decision.reason = `${target.reason} — ${plan.reason}`;
          return BTStatus.SUCCESS;
        }
        this.decision.state = AIState.EXPLORE;
        this.decision.targetEid = target.eid;
        this.decision.targetX = target.x;
        this.decision.targetY = target.y;
        this.decision.reason = target.reason;
        this.decision.npcInteraction = target.npcInteraction ? { ...target.npcInteraction } : null;
        return BTStatus.SUCCESS;
      }),
    );
  }

  private buildPriorityXpCleanupBehavior(): BTNode {
    return sequence(
      'Priority XP Cleanup',
      condition('Safe XP cleanup available', (ctx) => {
        const target = this.findPriorityXpCleanupTarget(ctx.world, ctx.playerX, ctx.playerY);
        if (!target) return false;
        ctx.blackboard['priorityXpCleanupTarget'] = target;
        return true;
      }),
      action('Set priority XP cleanup state', (ctx) => {
        const target = ctx.blackboard['priorityXpCleanupTarget'] as LootTarget;
        this.decision.state = AIState.COLLECT;
        this.decision.targetEid = target.eid;
        this.decision.targetX = target.x;
        this.decision.targetY = target.y;
        this.decision.reason =
          this.xpCleanupMode === 'exit'
            ? `Sweeping exit-route XP at distance ${target.distance.toFixed(1)}ft`
            : `Collecting local post-combat XP at distance ${target.distance.toFixed(1)}ft`;
        return BTStatus.SUCCESS;
      }),
    );
  }

  private findPriorityXpCleanupTarget(
    world: GameWorld,
    playerX: number,
    playerY: number,
  ): LootTarget | null {
    if (this.decision.state === AIState.ENGAGE) {
      this.xpCleanupCombatWindowUntilFrame =
        world.frameCount + XP_CLEANUP_COMBAT_LULL_WINDOW_FRAMES;
    }
    const exit = this.getFinalExitTarget(world);
    if (
      this.getCollapsePanicProfile(world).beeline ||
      (exit === null && this.isFloor2IntroductionPending(world)) ||
      this.hasLivingEnemyWithin(world, playerX, playerY, XP_CLEANUP_ENEMY_CLEARANCE_FT)
    ) {
      this.resetXpCleanupSession(false, world.frameCount);
      return null;
    }

    const mode = exit ? 'exit' : 'local';
    if (
      mode === 'local' &&
      this.xpCleanupMode === null &&
      world.frameCount > this.xpCleanupCombatWindowUntilFrame
    ) {
      this.resetXpCleanupSession(false, world.frameCount);
      return null;
    }
    if (this.xpCleanupMode !== null && this.xpCleanupMode !== mode) {
      this.resetXpCleanupSession(false, world.frameCount);
    }
    if (this.xpCleanupMode === null && world.frameCount < this.xpCleanupCooldownUntilFrame) {
      return null;
    }
    if (
      this.xpCleanupMode !== null &&
      world.frameCount - this.xpCleanupStartFrame >= XP_CLEANUP_MAX_FRAMES
    ) {
      this.resetXpCleanupSession(true, world.frameCount);
      return null;
    }

    const anchorX = this.xpCleanupMode === null ? playerX : this.xpCleanupAnchorX;
    const anchorY = this.xpCleanupMode === null ? playerY : this.xpCleanupAnchorY;
    const directExitDistance = exit ? Math.hypot(exit.x - playerX, exit.y - playerY) : 0;
    const candidates: LootTarget[] = [];
    for (const eid of query(world.ecs, [XpGem, Position])) {
      if (eid === undefined) continue;
      const ignoredUntil = this.ignoredLootUntilFrame.get(eid);
      if (ignoredUntil !== undefined && ignoredUntil > world.frameCount) continue;
      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      const distance = Math.hypot(x - playerX, y - playerY);
      if (mode === 'local') {
        if (
          Math.hypot(x - anchorX, y - anchorY) > LOCAL_XP_CLEANUP_RADIUS_FT ||
          distance > LOCAL_XP_CLEANUP_RADIUS_FT
        ) {
          continue;
        }
      } else if (exit) {
        const marginalDetour = distance + Math.hypot(exit.x - x, exit.y - y) - directExitDistance;
        if (marginalDetour > EXIT_XP_CLEANUP_DETOUR_BUDGET_FT) continue;
      }
      candidates.push({ eid, x, y, distance, kind: 'xp' });
    }

    candidates.sort((a, b) => a.distance - b.distance || a.eid - b.eid);
    for (const candidate of candidates.slice(0, XP_CLEANUP_MAX_PATH_CHECKS)) {
      if (!this.isLootCollectable(world, playerX, playerY, candidate)) continue;
      if (this.xpCleanupMode === null) {
        this.xpCleanupMode = mode;
        this.xpCleanupAnchorX = playerX;
        this.xpCleanupAnchorY = playerY;
        this.xpCleanupStartFrame = world.frameCount;
      }
      return candidate;
    }

    if (this.xpCleanupMode !== null) {
      this.resetXpCleanupSession(true, world.frameCount);
    }
    return null;
  }

  private hasLivingEnemyWithin(
    world: GameWorld,
    playerX: number,
    playerY: number,
    radiusFt: number,
  ): boolean {
    const radiusSq = radiusFt * radiusFt;
    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
      const dx = (world.stores.position.x[eid] ?? 0) - playerX;
      const dy = (world.stores.position.y[eid] ?? 0) - playerY;
      if (dx * dx + dy * dy <= radiusSq) return true;
    }
    return false;
  }

  private getFinalExitTarget(world: GameWorld): { x: number; y: number } | null {
    if (world.floorId === 'floor2') {
      const state = world.floorExtendedState?.familyState;
      return state?.staircaseSpawned &&
        state.staircaseUnlocked &&
        !state.staircaseDiscovered &&
        state.staircasePos
        ? state.staircasePos
        : null;
    }
    const objective = world.floorScenario?.objective;
    return objective?.staircaseUnlocked && !objective.staircaseDiscovered
      ? objective.staircasePos
      : null;
  }

  private resetXpCleanupSession(startCooldown: boolean, frameCount: number): void {
    this.xpCleanupMode = null;
    this.xpCleanupAnchorX = 0;
    this.xpCleanupAnchorY = 0;
    this.xpCleanupStartFrame = 0;
    if (startCooldown) {
      this.xpCleanupCooldownUntilFrame = frameCount + XP_CLEANUP_COOLDOWN_FRAMES;
    }
  }

  /**
   * No-progress valve for the NPC-approach threat-clear gate above. Tracks
   * player→NPC distance (not player→enemy distance) so the valve spans enemy
   * rotation caused by the per-enemy {@link ENGAGE_GIVEUP_FRAMES} watchdog —
   * only a stall in overall progress toward the NPC itself trips the bypass.
   * Returns true while threat-clear ENGAGE should keep firing for this target,
   * false once the bypass has latched (walk toward the NPC directly instead).
   */
  private shouldClearThreatBeforeNpc(target: ProgressTarget): boolean {
    if (this.npcApproachThreatNpcEid !== target.eid) {
      this.npcApproachThreatNpcEid = target.eid;
      this.npcApproachThreatBestDistance = target.distance;
      this.npcApproachThreatNoProgressFrames = 0;
      this.npcApproachThreatBypassEid = null;
      return true;
    }
    if (this.npcApproachThreatBypassEid === target.eid) {
      return false;
    }
    if (this.npcApproachThreatBestDistance - target.distance > ENGAGE_PROGRESS_EPSILON_FT) {
      this.npcApproachThreatBestDistance = target.distance;
      this.npcApproachThreatNoProgressFrames = 0;
      return true;
    }
    this.npcApproachThreatNoProgressFrames += 1;
    if (this.npcApproachThreatNoProgressFrames > NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES) {
      this.npcApproachThreatBypassEid = target.eid;
      return false;
    }
    return true;
  }

  /** Clear the NPC-approach threat-clear no-progress tracking/bypass. Called
   * whenever the nearby-threat gate is not active (no progress target, target
   * is not an NPC, target is already in interaction range, or no threat is
   * nearby) so a later re-entry starts fresh instead of inheriting a stale
   * bypass latch. */
  private resetNpcApproachThreatTracking(): void {
    this.npcApproachThreatNpcEid = null;
    this.npcApproachThreatBestDistance = Number.POSITIVE_INFINITY;
    this.npcApproachThreatNoProgressFrames = 0;
    this.npcApproachThreatBypassEid = null;
  }

  /**
   * Collect behavior: gather XP gems and loot.
   */
  private buildCollectBehavior(): BTNode {
    return sequence(
      'Collect',
      condition('Loot Nearby', (ctx) => {
        if (this.getCollapsePanicProfile(ctx.world).beeline) {
          return false;
        }
        const nearest = this.findNearestLoot(ctx.world, ctx.playerX, ctx.playerY);
        if (nearest && nearest.distance < this.config.scanRadius) {
          ctx.blackboard['nearestLoot'] = nearest;
          return true;
        }
        return false;
      }),
      action('Set Collect State', (ctx) => {
        const nearest = ctx.blackboard['nearestLoot'] as LootTarget;
        this.decision.state = AIState.COLLECT;
        this.decision.targetEid = nearest.eid;
        this.decision.targetX = nearest.x;
        this.decision.targetY = nearest.y;
        this.decision.reason = `Collecting ${nearest.kind} at distance ${nearest.distance.toFixed(1)}ft`;
        return BTStatus.SUCCESS;
      }),
    );
  }

  /**
   * Hunt behavior: move toward nearby enemies that are outside immediate engage range.
   */
  private buildHuntBehavior(): BTNode {
    return sequence(
      'Hunt',
      condition('Enemy In Scan Range', (ctx) => {
        const objective = ctx.world.floorScenario?.objective;
        if (
          !ctx.world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID) ||
          objective?.questCompleted === true
        ) {
          return false;
        }
        const tutorialLevelGrind =
          ctx.world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID) &&
          (ctx.world.playerLevel.level ?? 0) < 2;
        const huntScanRadius = tutorialLevelGrind
          ? Number.POSITIVE_INFINITY
          : this.config.scanRadius;
        const nearest = this.findNearestEnemy(ctx.world, ctx.playerX, ctx.playerY, huntScanRadius);
        if (!nearest) {
          return false;
        }
        const engageRadius = this.getEngageRadius(ctx.world);
        if (nearest.distance <= engageRadius || nearest.distance > huntScanRadius) {
          return false;
        }
        ctx.blackboard['huntEnemy'] = nearest;
        return true;
      }),
      action('Set Hunt State', (ctx) => {
        const nearest = ctx.blackboard['huntEnemy'] as WorldTarget;
        const plan = this.planEngagement(ctx.world, ctx.playerX, ctx.playerY, nearest);
        this.decision.state = AIState.ENGAGE;
        this.decision.targetEid = nearest.eid;
        this.decision.targetX = plan.targetX;
        this.decision.targetY = plan.targetY;
        this.decision.reason = `Hunting enemy at distance ${nearest.distance.toFixed(1)}ft`;
        return BTStatus.SUCCESS;
      }),
    );
  }

  /**
   * Leave-safe-room behavior: when the player is standing in a safe room and a
   * living enemy exists, drive *past* the nearest enemy to exit the safe zone.
   * The weapon is hard-disabled inside safe rooms (weaponSystem safe-space
   * gate), so holding melee range there is a permanent stalemate and the engage
   * watchdog would otherwise blacklist the entire wave as "unreachable". This
   * outranks Engage/Collect so the AI commits to leaving instead of oscillating
   * across the boundary.
   */
  private buildLeaveSafeRoomBehavior(): BTNode {
    return sequence(
      'LeaveSafeRoom',
      condition('Safe Room Egress With Threat', (ctx) => {
        const hasCommittedEgress =
          this.safeRoomEgressTargetX !== null && this.safeRoomEgressTargetY !== null;
        // `world.playerInSafeRoom` is a coarse, single-tile-boundary flag: it can
        // flip false for exactly one frame right as the player's feet cross the
        // doorway threshold, then flip back true the instant a lower-priority
        // behavior (e.g. Hunt, once this condition stops gating it) nudges them
        // back over the line — which re-arms this condition, pushing them across
        // again, forever. That produced a frame-perfect livelock at the doorway
        // (net-zero progress, oscillating decision.reason every single frame —
        // see sword@14 root-cause writeup). `updateSafeRoomEgressWaypointLatch`
        // (called once per poll, before this tree runs) already implements the
        // grace window this is meant to use: it only clears a committed egress
        // target after SAFE_ROOM_EGRESS_EXIT_HYSTERESIS_FRAMES consecutive frames
        // genuinely outside the safe room, resetting that counter to 0 the instant
        // playerInSafeRoom flips back true. This condition used to ignore that
        // latch entirely and bail on ANY single flicker frame, defeating the
        // hysteresis it was built to provide. Trust the latch instead: starting a
        // BRAND NEW egress still requires genuinely being inside the safe room;
        // an already-committed, in-flight egress may keep driving until the latch
        // itself releases it (bounded to that window, not until arrival).
        if (!ctx.world.playerInSafeRoom && !hasCommittedEgress) {
          // NOTE: unlike the pre-fix code, this branch can now be reached after a
          // no-progress/max-active watchdog trip that happened while genuinely
          // outside (see below) — that trip already set a fresh
          // safeRoomEgressSuppressFrames cooldown intended to hold off
          // LeaveSafeRoom for SAFE_ROOM_EGRESS_SUPPRESS_FRAMES once back inside.
          // Do NOT zero it here: Guard 2 below only ever consumes it while
          // genuinely inside the safe room, so leaving it untouched here simply
          // preserves that cooldown until it's actually spent; zeroing it would
          // collapse a just-armed 120-frame cooldown to effectively nothing the
          // very next frame.
          return false;
        }
        if (ctx.world.playerInSafeRoom && this.safeRoomEgressSuppressFrames > 0) {
          this.safeRoomEgressSuppressFrames -= 1;
          return false;
        }
        if (this.safeRoomEgressTargetX !== null && this.safeRoomEgressTargetY !== null) {
          const waypointInSafeSpace = isPointInSafeSpace(
            ctx.world,
            this.safeRoomEgressTargetX,
            this.safeRoomEgressTargetY,
          );
          const distToWaypoint = Math.hypot(
            this.safeRoomEgressTargetX - ctx.playerX,
            this.safeRoomEgressTargetY - ctx.playerY,
          );
          if (!waypointInSafeSpace && distToWaypoint > WAYPOINT_ARRIVE_FT) {
            if (
              distToWaypoint + SAFE_ROOM_EGRESS_PROGRESS_EPSILON_FT <
              this.safeRoomEgressBestDistanceFt
            ) {
              this.safeRoomEgressBestDistanceFt = distToWaypoint;
              this.safeRoomEgressNoProgressFrames = 0;
            } else {
              this.safeRoomEgressNoProgressFrames += 1;
            }
            if (this.safeRoomEgressNoProgressFrames > SAFE_ROOM_EGRESS_NO_PROGRESS_FRAMES) {
              this.clearSafeRoomEgressWaypoint();
              // Drop LeaveSafeRoom for this poll so lower-priority logic can
              // pick an alternate move target instead of instantly re-latching
              // the same waypoint and oscillating.
              this.safeRoomEgressSuppressFrames = SAFE_ROOM_EGRESS_SUPPRESS_FRAMES;
              return false;
            } else {
              const threatEid = this.safeRoomEgressThreatEid;
              const threatX =
                typeof threatEid === 'number' ? ctx.world.stores.position.x[threatEid] : undefined;
              const threatY =
                typeof threatEid === 'number' ? ctx.world.stores.position.y[threatEid] : undefined;
              const threatDistance =
                typeof threatX === 'number' && typeof threatY === 'number'
                  ? Math.hypot(threatX - ctx.playerX, threatY - ctx.playerY)
                  : null;
              ctx.blackboard['safeRoomEgress'] = {
                x: this.safeRoomEgressTargetX,
                y: this.safeRoomEgressTargetY,
                threatDistance,
              };
              return true;
            }
          }
          this.clearSafeRoomEgressWaypoint();
        }
        // The prior egress (if any) is done or was never committed. Starting a
        // fresh one still requires genuinely being inside the safe room — a
        // momentary flicker with no committed target in flight shouldn't kick
        // one off.
        if (!ctx.world.playerInSafeRoom) {
          return false;
        }
        // During the tutorial's pre-level-2 grind, relying on the default 50ft
        // scan can deadlock in the safe room when the nearest swarm is just
        // outside that radius. Use an unbounded threat search only for this phase
        // so the AI always acquires an egress target and leaves the safe room.
        const tutorialAccepted = ctx.world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID);
        const forceTutorialEgress = tutorialAccepted && (ctx.world.playerLevel.level ?? 0) < 2;
        const nearest = this.findNearestEnemy(
          ctx.world,
          ctx.playerX,
          ctx.playerY,
          forceTutorialEgress ? Number.POSITIVE_INFINITY : this.config.scanRadius,
        );
        if (!nearest) {
          this.clearSafeRoomEgressWaypoint();
          return false;
        }
        const egress = this.computeSafeRoomEgressWaypoint(
          ctx.world,
          ctx.playerX,
          ctx.playerY,
          nearest,
        );
        if (egress === null) {
          this.clearSafeRoomEgressWaypoint();
          return false;
        }
        this.safeRoomEgressTargetX = egress.x;
        this.safeRoomEgressTargetY = egress.y;
        this.safeRoomEgressThreatEid = nearest.eid;
        this.safeRoomEgressBestDistanceFt = Math.hypot(
          egress.x - ctx.playerX,
          egress.y - ctx.playerY,
        );
        this.safeRoomEgressNoProgressFrames = 0;
        ctx.blackboard['safeRoomEgress'] = {
          x: egress.x,
          y: egress.y,
          threatDistance: nearest.distance,
        };
        return true;
      }),
      action('Set Leave Safe Room State', (ctx) => {
        this.safeRoomEgressActiveFrames += 1;
        if (this.safeRoomEgressActiveFrames > SAFE_ROOM_EGRESS_MAX_ACTIVE_FRAMES) {
          this.clearSafeRoomEgressWaypoint();
          this.safeRoomEgressSuppressFrames = SAFE_ROOM_EGRESS_SUPPRESS_FRAMES;
          return BTStatus.FAILURE;
        }
        const egress = ctx.blackboard['safeRoomEgress'] as {
          x: number;
          y: number;
          threatDistance: number | null;
        };
        this.decision.state = AIState.ENGAGE;
        // Keep targetEid null while egressing: ENGAGE's pursuit fallback and
        // pointer-lock both prefer targetEid, which would otherwise re-couple this
        // state to a moving threat and reintroduce mouth oscillation.
        this.decision.targetEid = null;
        this.decision.targetX = egress.x;
        this.decision.targetY = egress.y;
        const threatText =
          typeof egress.threatDistance === 'number'
            ? ` (enemy ${egress.threatDistance.toFixed(1)}ft)`
            : '';
        this.decision.reason = `Leaving safe room via latched egress waypoint${threatText}`;
        return BTStatus.SUCCESS;
      }),
    );
  }

  private clearSafeRoomEgressWaypoint(): void {
    this.safeRoomEgressTargetX = null;
    this.safeRoomEgressTargetY = null;
    this.safeRoomEgressThreatEid = null;
    this.safeRoomEgressOutsideFrames = 0;
    this.safeRoomEgressBestDistanceFt = Number.POSITIVE_INFINITY;
    this.safeRoomEgressNoProgressFrames = 0;
    this.safeRoomEgressActiveFrames = 0;
    this.safeRoomEgressSuppressFrames = 0;
  }

  private updateSafeRoomEgressWaypointLatch(
    world: GameWorld,
    playerX: number,
    playerY: number,
  ): void {
    if (this.safeRoomEgressTargetX === null || this.safeRoomEgressTargetY === null) {
      this.safeRoomEgressOutsideFrames = 0;
      return;
    }
    const targetX = this.safeRoomEgressTargetX;
    const targetY = this.safeRoomEgressTargetY;
    const distToWaypoint = Math.hypot(targetX - playerX, targetY - playerY);
    if (distToWaypoint <= WAYPOINT_ARRIVE_FT) {
      this.clearSafeRoomEgressWaypoint();
      return;
    }
    if (world.playerInSafeRoom) {
      this.safeRoomEgressOutsideFrames = 0;
      return;
    }
    this.safeRoomEgressOutsideFrames += 1;
    if (this.safeRoomEgressOutsideFrames >= SAFE_ROOM_EGRESS_EXIT_HYSTERESIS_FRAMES) {
      this.clearSafeRoomEgressWaypoint();
    }
  }

  private computeSafeRoomEgressWaypoint(
    world: GameWorld,
    playerX: number,
    playerY: number,
    threat: WorldTarget,
  ): { x: number; y: number } | null {
    const dx = threat.x - playerX;
    const dy = threat.y - playerY;
    const len = Math.hypot(dx, dy);
    if (len <= 0) {
      return null;
    }
    const rawTargetX = threat.x + (dx / len) * SAFE_ROOM_EXIT_OVERSHOOT_FT;
    const rawTargetY = threat.y + (dy / len) * SAFE_ROOM_EXIT_OVERSHOOT_FT;
    const floorMap = world.floorMap;
    if (!floorMap) {
      return { x: rawTargetX, y: rawTargetY };
    }
    const startTile = floorMap.worldToTile(playerX, playerY);
    const goalTile = floorMap.worldToTile(rawTargetX, rawTargetY);
    const resolvedTile = this.resolveReachableGoalTile(floorMap, startTile, goalTile);
    const resolved = floorMap.tileToWorld(resolvedTile.x, resolvedTile.y);
    if (!isPointInSafeSpace(world, resolved.x, resolved.y)) {
      return resolved;
    }
    const fallbackRawX = threat.x + (dx / len) * (SAFE_ROOM_EXIT_OVERSHOOT_FT * 2);
    const fallbackRawY = threat.y + (dy / len) * (SAFE_ROOM_EXIT_OVERSHOOT_FT * 2);
    const fallbackTile = floorMap.worldToTile(fallbackRawX, fallbackRawY);
    const fallbackResolvedTile = this.resolveReachableGoalTile(floorMap, startTile, fallbackTile);
    const fallbackResolved = floorMap.tileToWorld(fallbackResolvedTile.x, fallbackResolvedTile.y);
    if (!isPointInSafeSpace(world, fallbackResolved.x, fallbackResolved.y)) {
      return fallbackResolved;
    }
    return null;
  }

  /**
   * Engage behavior: attack enemies.
   */
  private buildEngageBehavior(): BTNode {
    return sequence(
      'Engage',
      condition('Enemy Nearby', (ctx) => {
        const nearest = this.findNearestEnemy(ctx.world, ctx.playerX, ctx.playerY);
        if (nearest && nearest.distance <= this.getEngageRadius(ctx.world)) {
          ctx.blackboard['nearestEnemy'] = nearest;
          return true;
        }
        return false;
      }),
      action('Set Engage State', (ctx) => {
        const nearest = ctx.blackboard['nearestEnemy'] as WorldTarget;
        const plan = this.planEngagement(ctx.world, ctx.playerX, ctx.playerY, nearest);
        this.decision.state = AIState.ENGAGE;
        this.decision.targetEid = nearest.eid;
        this.decision.targetX = plan.targetX;
        this.decision.targetY = plan.targetY;
        this.decision.reason = plan.reason;
        return BTStatus.SUCCESS;
      }),
    );
  }

  /**
   * Explore behavior: wander when nothing else to do.
   */
  private buildExploreBehavior(): BTNode {
    return sequence(
      'Explore',
      action('Set Explore State', (ctx) => {
        this.decision.state = AIState.EXPLORE;
        this.decision.targetEid = null;
        this.decision.reason = 'Exploring map';
        this.decision.debug = this.pendingSuppressedProgressNavDebug
          ? { ...this.pendingSuppressedProgressNavDebug }
          : null;

        // Pick a random exploration target if we don't have one
        if (this.decision.targetX === null || this.decision.targetY === null) {
          const target = this.pickExploreTarget(ctx.world, ctx.playerX, ctx.playerY);
          this.decision.targetX = target.x;
          this.decision.targetY = target.y;
        }

        // If we're close to exploration target, pick a new one
        if (this.decision.targetX !== null && this.decision.targetY !== null) {
          const dist = Math.hypot(
            ctx.playerX - this.decision.targetX,
            ctx.playerY - this.decision.targetY,
          );
          if (dist < 6.25) {
            const target = this.pickExploreTarget(ctx.world, ctx.playerX, ctx.playerY);
            this.decision.targetX = target.x;
            this.decision.targetY = target.y;
          }
        }

        return BTStatus.SUCCESS;
      }),
    );
  }

  /**
   * Opportunistic layer (Track B): ticks every frame in parallel with Track A.
   *
   * Children write into `this.opportunisticPullX/Y` and `this.dodgeVecX/Y`
   * which poll() blends additively into the Track A direction vector before
   * the smoothing step. None of these nodes update `this.decision`, so they
   * cannot break Track A's state machine.
   */
  private buildOpportunisticLayer(): BTNode {
    return parallel(
      'Track B: Opportunistic',
      BTParallelPolicy.OBSERVE,
      // Dodge runs before Collect so the loot detour can see an in-progress dodge
      // this frame (the player's rule: don't detour for loot while dodging).
      this.buildOpportunisticDodge(),
      this.buildOpportunisticCollect(),
      this.buildOpportunisticFarm(),
    );
  }

  /**
   * OpportunisticCollect: nudge the player into a *slight detour* toward loot it
   * is travelling past, so it scoops up on-path gems/gold/items while navigating
   * elsewhere (including toward quest objectives) without switching Track A state.
   *
   * Implements the player's rule directly: "if there is loot within 5' of my path
   * and I am not actively fighting or dodging enemies, make the slight detour to
   * grab it." A loot qualifies only when it lies AHEAD of the player along the
   * current heading and its perpendicular distance to that path ray is within
   * `PATH_CORRIDOR_HALF_WIDTH_FT` (5 ft). The earlier implementation pulled toward
   * ANY nearby loot in any direction, which systematically biased the net
   * trajectory toward loot-dense (= recently enemy-killed) zones and blew the
   * floor-clear budget. Restricting to a narrow forward corridor keeps the detour
   * genuinely slight: the player can curve toward stuff on its way but is never
   * dragged backward or sideways into off-path fights.
   *
   * Skipped when Track A is already in COLLECT (no point doubling up), when the
   * player is retreating or actively engaging an enemy ("fighting or dodging"),
   * when a dodge impulse is active this frame ("dodging"), and during NPC
   * interaction (the brief final-approach micro-phase mustn't be deflected; the
   * long travel toward an NPC objective happens in EXPLORE and IS eligible).
   * Unlike before it is NOT skipped during Progress-driven navigation (EXPLORE
   * with a non-null targetEid): the forward corridor makes a quest-path detour
   * safe because only loot already on the way to the objective is pulled.
   */
  private buildOpportunisticCollect(): BTNode {
    return action('Opportunistic Collect', (ctx) => {
      if (this.isFloor2IntroductionPending(ctx.world)) return BTStatus.FAILURE;
      // Track A is handling collection, survival/fighting takes priority, and NPC
      // interaction must not be deflected.
      if (
        this.decision.state === AIState.COLLECT ||
        this.decision.state === AIState.RETREAT ||
        this.decision.state === AIState.ENGAGE ||
        this.decision.state === AIState.INTERACT
      ) {
        return BTStatus.FAILURE;
      }
      if (this.getCollapsePanicProfile(ctx.world).beeline) return BTStatus.FAILURE;

      // "...and I am not actively dodging enemies." Dodge ticks before Collect in
      // the Track B parallel, so a non-zero dodge vector means a dodge is in
      // progress this frame — defer the loot detour until it clears.
      if (this.dodgeVecX !== 0 || this.dodgeVecY !== 0) return BTStatus.FAILURE;

      // Path ray = the direction the player is currently travelling (previous-frame
      // smoothed output). With no meaningful heading the player is effectively
      // stationary, so there is no "path" to detour from — let Track A's Collect
      // behavior handle stationary pickups instead.
      const headingMag = Math.hypot(this.smoothMoveX, this.smoothMoveY);
      if (headingMag < DETOUR_MIN_HEADING_MAGNITUDE) return BTStatus.FAILURE;
      const headingX = this.smoothMoveX / headingMag;
      const headingY = this.smoothMoveY / headingMag;

      // Pick the nearest loot within the grab radius that is AHEAD of the player
      // and within PATH_CORRIDOR_HALF_WIDTH_FT of the path ray. Loot behind, or
      // farther to the side than the corridor, is ignored so the detour stays
      // slight and cannot bias the net trajectory.
      let nearestX = 0;
      let nearestY = 0;
      let nearestDist = Number.POSITIVE_INFINITY;
      let found = false;

      const grabRadius = this.config.opportunisticGrabRadius;
      const candidates: Array<{ kind: LootKind; entities: ReturnType<typeof query> }> = [
        { kind: 'xp', entities: query(ctx.world.ecs, [XpGem, Position]) },
        { kind: 'gold', entities: query(ctx.world.ecs, [Gold, Position]) },
        { kind: 'item', entities: query(ctx.world.ecs, [DroppedItem, Position]) },
      ];
      for (const candidate of candidates) {
        for (const eid of candidate.entities) {
          if (eid === undefined) continue;
          const ignored = this.ignoredLootUntilFrame.get(eid);
          if (ignored !== undefined && ignored > ctx.world.frameCount) continue;
          const lx = ctx.world.stores.position.x[eid] ?? 0;
          const ly = ctx.world.stores.position.y[eid] ?? 0;
          const dxl = lx - ctx.playerX;
          const dyl = ly - ctx.playerY;
          const d = Math.hypot(dxl, dyl);
          if (d >= grabRadius || d >= nearestDist) continue;
          // Forward projection onto the heading: loot must be ahead (on the path),
          // not behind the player.
          const forward = dxl * headingX + dyl * headingY;
          if (forward < 0) continue;
          // Perpendicular distance from the path ray must be within the corridor.
          const lateralSq = d * d - forward * forward;
          const lateral = lateralSq > 0 ? Math.sqrt(lateralSq) : 0;
          if (lateral > PATH_CORRIDOR_HALF_WIDTH_FT) continue;
          nearestDist = d;
          nearestX = lx;
          nearestY = ly;
          found = true;
        }
      }

      if (!found) return BTStatus.FAILURE;

      const dx = nearestX - ctx.playerX;
      const dy = nearestY - ctx.playerY;
      const dist = Math.hypot(dx, dy);
      if (dist > 0) {
        this.opportunisticPullX = dx / dist;
        this.opportunisticPullY = dy / dist;
      }
      return BTStatus.SUCCESS;
    });
  }

  /**
   * OpportunisticDodge: sidestep collision-course projectiles in every movement
   * state, then fall back to the travel-only enemy dodge.
   *
   * For each enemy within `DODGE_THREAT_RADIUS_FT`, we compute the dot product
   * of its velocity with the toward-player unit vector. If the closing speed
   * exceeds `DODGE_CLOSING_SPEED_FT_PER_FRAME`, we pick the perpendicular that
   * keeps the kite orbit sign and write it into `this.dodgeVecX/Y`.
   *
   * Path-blocking sidestep: a stationary/slow enemy that sits within
   * `DODGE_BLOCK_RADIUS_FT` and roughly ahead of the travel heading would never
   * "close" yet the player would walk straight into it (the bulldozing seen on
   * quest beelines). Such an enemy triggers a perpendicular sidestep toward the
   * open side so the player curves around instead of trading body contact.
   *
   * Only the closest qualifying enemy drives the dodge so the vector is stable.
   */
  private buildOpportunisticDodge(): BTNode {
    return action('Opportunistic Dodge', (ctx) => {
      // NPC interaction must not be deflected from its exact approach target.
      if (this.decision.state === AIState.INTERACT) {
        return BTStatus.FAILURE;
      }

      const projectiles = query(ctx.world.ecs, [EnemyProjectile, Position, Velocity]);
      const playerVx = ctx.world.stores.velocity.x[ctx.playerEid] ?? 0;
      const playerVy = ctx.world.stores.velocity.y[ctx.playerEid] ?? 0;
      let earliestImpactFrames = Number.POSITIVE_INFINITY;
      let projectileDodgeX = 0;
      let projectileDodgeY = 0;

      for (const eid of projectiles) {
        if (eid === undefined) continue;
        const projectileX = ctx.world.stores.position.x[eid] ?? 0;
        const projectileY = ctx.world.stores.position.y[eid] ?? 0;
        const relativeX = projectileX - ctx.playerX;
        const relativeY = projectileY - ctx.playerY;
        const projectileVx = ctx.world.stores.velocity.x[eid] ?? 0;
        const projectileVy = ctx.world.stores.velocity.y[eid] ?? 0;
        const relativeVx = projectileVx - playerVx;
        const relativeVy = projectileVy - playerVy;
        const speedSq = relativeVx * relativeVx + relativeVy * relativeVy;
        if (speedSq <= Number.EPSILON) continue;

        const impactFrames = -(relativeX * relativeVx + relativeY * relativeVy) / speedSq;
        if (
          impactFrames < 0 ||
          impactFrames > PROJECTILE_DODGE_HORIZON_FRAMES ||
          impactFrames >= earliestImpactFrames
        ) {
          continue;
        }

        const closestX = relativeX + relativeVx * impactFrames;
        const closestY = relativeY + relativeVy * impactFrames;
        const closestDistance = Math.hypot(closestX, closestY);
        const aoeRadius = hasComponent(ctx.world.ecs, eid, AoeOnImpact)
          ? (ctx.world.stores.aoeOnImpact.radius[eid] ?? 0)
          : 0;
        const requiredClearance =
          aoeRadius > 0
            ? aoeRadius + PROJECTILE_DODGE_AOE_BUFFER_FT
            : PROJECTILE_DODGE_CLEARANCE_FT;
        if (closestDistance > requiredClearance) continue;

        if (closestDistance > Number.EPSILON) {
          // Move away from the projectile's nearest point on its future path.
          projectileDodgeX = -closestX / closestDistance;
          projectileDodgeY = -closestY / closestDistance;
        } else {
          // Dead-center trajectory: choose a deterministic perpendicular.
          const speed = Math.sqrt(speedSq);
          projectileDodgeX = (-relativeVy / speed) * this.kiteOrbitSign;
          projectileDodgeY = (relativeVx / speed) * this.kiteOrbitSign;
        }
        earliestImpactFrames = impactFrames;
      }

      // Telegraphed-but-not-yet-fired shots: the aim/origin are already
      // LOCKED (see core/systems/enemyTelegraph.ts), so a virtual projectile
      // can be dodged before it even spawns — reading the same public,
      // deterministic EnemyBehavior store fields the render cue and the real
      // fire logic use (no privileged prediction). Competes uniformly with
      // real in-flight projectiles above for "closest threat first" priority
      // via the shared earliestImpactFrames/projectileDodgeX/Y race.
      const enemyBehaviorStore = ctx.world.stores.enemyBehavior;
      for (const eid of query(ctx.world.ecs, [Enemy, Position])) {
        if (eid === undefined) continue;
        if (enemyBehaviorStore.telegraphActive[eid] !== 1) continue;
        // A shooter that died earlier this simulation step can still have
        // `telegraphActive` set here (this pass runs before enemyAISystem's
        // DeathTimer processing cancels it), which would make the player dodge
        // a shot guaranteed to be cancelled. Filter non-positive health, same
        // as the closing-speed danger scorer above.
        if ((ctx.world.stores.health.current[eid] ?? 0) <= 0) continue;

        const originX = enemyBehaviorStore.telegraphOriginX[eid] ?? 0;
        const originY = enemyBehaviorStore.telegraphOriginY[eid] ?? 0;
        // Gate on the shooter's LIVE position (not the locked telegraph
        // origin) using STRICT current FOV (matching PhaserBridge's cue gate
        // at PhaserBridge.ts's isVisible computation exactly) — knockback can
        // displace a shooter after its telegraph origin is locked, and
        // canPerceiveWorldPosition's discovered-tile memory would otherwise
        // let the AI dodge a threat the render cue is not currently showing.
        const liveX = ctx.world.stores.position.x[eid] ?? originX;
        const liveY = ctx.world.stores.position.y[eid] ?? originY;
        if (!this.canCurrentlyPerceiveWorldPosition(ctx.world, liveX, liveY)) continue;

        const dirX = enemyBehaviorStore.telegraphDirX[eid] ?? 0;
        const dirY = enemyBehaviorStore.telegraphDirY[eid] ?? 0;
        const startMs = enemyBehaviorStore.telegraphStartMs[eid] ?? 0;
        const delayMs = enemyBehaviorStore.telegraphDelayMs[eid] ?? 0;
        const remainingMs = Math.max(0, delayMs - (ctx.world.elapsedMs - startMs));
        // This AI's poll() runs BEFORE runSimulationStep() advances
        // world.elapsedMs and runs preSystems for the CURRENT step (see
        // headless-runner.ts's main loop and simulation-step.ts), while
        // isEnemyProjectileTelegraphReady's fire check runs AFTER that same
        // increment but BEFORE that step's movementSystem
        // (simulation-core-step.ts's preSystems -> movementSystem order). So
        // from any poll, the raw fractional quotient
        // (remainingMs / DELTA_MS) is exactly one step too many: the step on
        // which the shot fires still advances elapsedMs and triggers the fire
        // check, but the PLAYER's movement for that same step happens after
        // the fire (movementSystem runs after preSystems), so it never
        // occurs before the shot spawns. The number of player-movement steps
        // that will actually happen before the fire is
        // ceil(remainingMs / DELTA_MS) - 1, clamped at 0 (regression:
        // copilot-pull-request-reviewer finding).
        const remainingFrames = Math.max(0, Math.ceil(remainingMs / GAME.DELTA_MS) - 1);

        // The enemy is pinned at the locked origin for the whole telegraph
        // (see enemyAISystem.ts's movement freeze), so only the player needs
        // to be projected forward to the instant the virtual shot spawns.
        // The virtual projectile starts at the exact locked ECS/visual pivot,
        // matching fireEnemyProjectileFrom(). Keeping the raw origin here makes
        // the AI's threat timing identical to the real projectile spawn.
        const spawnX = originX;
        const spawnY = originY;
        const projectedPlayerX = ctx.playerX + playerVx * remainingFrames;
        const projectedPlayerY = ctx.playerY + playerVy * remainingFrames;
        const relativeX = spawnX - projectedPlayerX;
        const relativeY = spawnY - projectedPlayerY;

        const projectileSpeed = TELEGRAPH_FIREBALL_DEF?.projectileSpeed ?? ENEMY_PROJECTILE.SPEED;
        const relativeVx = dirX * projectileSpeed - playerVx;
        const relativeVy = dirY * projectileSpeed - playerVy;
        const speedSq = relativeVx * relativeVx + relativeVy * relativeVy;
        if (speedSq <= Number.EPSILON) continue;

        let impactFramesAfterSpawn = -(relativeX * relativeVx + relativeY * relativeVy) / speedSq;
        if (impactFramesAfterSpawn < 0) continue;
        // The real fire path spawns via spawnAoeProjectile(..., FIREBALL_DEF.range)
        // (see enemyAISystem.ts's fireEnemyProjectileFrom), and
        // projectileCleanupSystem despawns a projectile once it has traveled
        // that far from its spawn point — but that check runs AFTER
        // movement + collision + damage each step (simulation-core-step.ts:
        // movementSystem, collisionSystem, damageSystem, ..., then
        // projectileCleanupSystem last), so the real shot can still land on
        // the exact step where it first exceeds maxRange, one whole step
        // beyond the nominal boundary. Rejecting every candidate whose
        // analytic closest-approach point lies beyond rangeFt (rather than
        // this true last-reachable step) makes the AI ignore a threat that
        // can genuinely still hit. `dirX`/`dirY` are a unit vector (see
        // enemyAISystem's `normalize()` call before
        // `startEnemyProjectileTelegraph`), so distance traveled after N
        // whole steps is simply `projectileSpeed * N`; the last step at
        // which the projectile is still alive to collide is the smallest
        // integer step whose traveled distance first exceeds rangeFt, i.e.
        // `floor(rangeFt / projectileSpeed) + 1`. Relative distance to the
        // player is convex in time for constant relative velocity, so when
        // the unconstrained analytic minimum lies beyond that last
        // reachable step, clamping to the step itself still yields the true
        // closest reachable point (rather than skipping the threat outright).
        const rangeFt = TELEGRAPH_FIREBALL_DEF?.range ?? 0;
        if (rangeFt > 0) {
          const maxReachableFrames = Math.floor(rangeFt / projectileSpeed) + 1;
          if (impactFramesAfterSpawn > maxReachableFrames) {
            impactFramesAfterSpawn = maxReachableFrames;
          }
        }
        const totalImpactFrames = remainingFrames + impactFramesAfterSpawn;
        if (
          totalImpactFrames > PROJECTILE_DODGE_HORIZON_FRAMES ||
          totalImpactFrames >= earliestImpactFrames
        ) {
          continue;
        }

        const closestX = relativeX + relativeVx * impactFramesAfterSpawn;
        const closestY = relativeY + relativeVy * impactFramesAfterSpawn;
        const closestDistance = Math.hypot(closestX, closestY);
        const aoeRadius = TELEGRAPH_FIREBALL_DEF?.aoeRadius ?? 0;
        const requiredClearance =
          aoeRadius > 0
            ? aoeRadius + PROJECTILE_DODGE_AOE_BUFFER_FT
            : PROJECTILE_DODGE_CLEARANCE_FT;
        if (closestDistance > requiredClearance) continue;

        if (closestDistance > Number.EPSILON) {
          projectileDodgeX = -closestX / closestDistance;
          projectileDodgeY = -closestY / closestDistance;
        } else {
          const speed = Math.sqrt(speedSq);
          projectileDodgeX = (-relativeVy / speed) * this.kiteOrbitSign;
          projectileDodgeY = (relativeVx / speed) * this.kiteOrbitSign;
        }
        earliestImpactFrames = totalImpactFrames;
      }

      if (earliestImpactFrames < Number.POSITIVE_INFINITY) {
        this.dodgeVecX = projectileDodgeX * PROJECTILE_DODGE_VECTOR_SCALE;
        this.dodgeVecY = projectileDodgeY * PROJECTILE_DODGE_VECTOR_SCALE;
        return BTStatus.SUCCESS;
      }

      // Mob-ability geometry avoidance: if the player is inside a committed
      // telegraph / active danger footprint, flee using the same public
      // geometry the renderer draws — no information advantage over what the
      // player sees. Runs only when no projectile threat is in the dodge horizon.
      const maybeDodgeCircle = (circle: { x: number; y: number; radiusFt: number }): boolean => {
        const dx = ctx.playerX - circle.x;
        const dy = ctx.playerY - circle.y;
        const distSq = dx * dx + dy * dy;
        const r2 = circle.radiusFt * circle.radiusFt;
        if (distSq > r2) return false;
        const dist = Math.sqrt(distSq);
        if (dist > Number.EPSILON) {
          this.dodgeVecX = (dx / dist) * PROJECTILE_DODGE_VECTOR_SCALE;
          this.dodgeVecY = (dy / dist) * PROJECTILE_DODGE_VECTOR_SCALE;
        } else {
          this.dodgeVecX = this.kiteOrbitSign * PROJECTILE_DODGE_VECTOR_SCALE;
          this.dodgeVecY = 0;
        }
        return true;
      };
      for (const cue of ctx.world.mobAbilities.cues) {
        const { geometry } = cue;
        if (geometry.kind === 'radial-projectiles') {
          const relX = ctx.playerX - geometry.casterX;
          const relY = ctx.playerY - geometry.casterY;
          const radialDist = Math.hypot(relX, relY);
          if (radialDist <= geometry.spokeLengthFt) {
            const stepDeg = 360 / geometry.count;
            const playerAngleDeg = ((((Math.atan2(relY, relX) * 180) / Math.PI) % 360) + 360) % 360;
            let nearestDeltaDeg = 180;
            let nearestSpokeRad = 0;
            for (let i = 0; i < geometry.count; i += 1) {
              const spokeDeg = (i / geometry.count) * 360 + geometry.offsetDeg;
              const deltaDeg = ((playerAngleDeg - spokeDeg + 540) % 360) - 180;
              const absDeltaDeg = Math.abs(deltaDeg);
              if (absDeltaDeg < nearestDeltaDeg) {
                nearestDeltaDeg = absDeltaDeg;
                nearestSpokeRad = (spokeDeg * Math.PI) / 180;
              }
            }
            const laneHalfWidthDeg =
              (Math.atan2(PROJECTILE_DODGE_CLEARANCE_FT, Math.max(radialDist, 1e-6)) * 180) /
              Math.PI;
            if (nearestDeltaDeg <= Math.min(stepDeg * 0.45, laneHalfWidthDeg)) {
              const spokeDirX = Math.cos(nearestSpokeRad);
              const spokeDirY = Math.sin(nearestSpokeRad);
              const cross = relX * spokeDirY - relY * spokeDirX;
              const side = cross >= 0 ? 1 : -1;
              this.dodgeVecX = -spokeDirY * side * PROJECTILE_DODGE_VECTOR_SCALE;
              this.dodgeVecY = spokeDirX * side * PROJECTILE_DODGE_VECTOR_SCALE;
              return BTStatus.SUCCESS;
            }
          }
          continue;
        }
        if (geometry.kind === 'lane') {
          const segX = geometry.endX - geometry.originX;
          const segY = geometry.endY - geometry.originY;
          const segLenSq = segX * segX + segY * segY;
          if (segLenSq <= Number.EPSILON) continue;
          const relX = ctx.playerX - geometry.originX;
          const relY = ctx.playerY - geometry.originY;
          const t = Math.max(0, Math.min(1, (relX * segX + relY * segY) / segLenSq));
          const closestX = geometry.originX + segX * t;
          const closestY = geometry.originY + segY * t;
          const offX = ctx.playerX - closestX;
          const offY = ctx.playerY - closestY;
          const laneHalfWidth = geometry.widthFt * 0.5;
          const playerBodyRadius = Math.max(
            getBodyHalfWidth(ctx.world, ctx.playerEid, 'btAiProvider'),
            getBodyHalfHeight(ctx.world, ctx.playerEid, 'btAiProvider'),
          );
          const hitClearance = laneHalfWidth + playerBodyRadius;
          const offDistSq = offX * offX + offY * offY;
          if (offDistSq > hitClearance * hitClearance) continue;
          const offDist = Math.sqrt(offDistSq);
          if (offDist > Number.EPSILON) {
            this.dodgeVecX = (offX / offDist) * PROJECTILE_DODGE_VECTOR_SCALE;
            this.dodgeVecY = (offY / offDist) * PROJECTILE_DODGE_VECTOR_SCALE;
          } else {
            this.dodgeVecX = -geometry.dirY * PROJECTILE_DODGE_VECTOR_SCALE;
            this.dodgeVecY = geometry.dirX * PROJECTILE_DODGE_VECTOR_SCALE;
          }
          return BTStatus.SUCCESS;
        }
        if (geometry.kind === 'projectile-fan') {
          const dx = ctx.playerX - geometry.originX;
          const dy = ctx.playerY - geometry.originY;
          const distSq = dx * dx + dy * dy;
          const rangeSq = geometry.rangeFt * geometry.rangeFt;
          const targetAngle = Math.atan2(dy, dx);
          const delta = Math.atan2(
            Math.sin(targetAngle - geometry.facingRad),
            Math.cos(targetAngle - geometry.facingRad),
          );
          const halfRad = (geometry.coneAngleDeg * Math.PI) / 360;
          if (distSq <= rangeSq && Math.abs(delta) <= halfRad) {
            const lateralSign =
              Math.abs(delta) <= Number.EPSILON ? this.kiteOrbitSign : Math.sign(delta);
            const lateralX = -Math.sin(geometry.facingRad) * lateralSign;
            const lateralY = Math.cos(geometry.facingRad) * lateralSign;
            this.dodgeVecX = lateralX * PROJECTILE_DODGE_VECTOR_SCALE;
            this.dodgeVecY = lateralY * PROJECTILE_DODGE_VECTOR_SCALE;
            return BTStatus.SUCCESS;
          }
          continue;
        }
        const cueCircles =
          geometry.kind === 'circle'
            ? [geometry]
            : geometry.kind === 'spawn-circles' || geometry.kind === 'multi-circle'
              ? geometry.circles
              : [];
        for (const circle of cueCircles) {
          if (maybeDodgeCircle(circle)) return BTStatus.SUCCESS;
        }
      }
      for (const zone of ctx.world.mobAbilities.ownedZones) {
        const { geometry } = zone;
        if (
          geometry.kind === 'lane' ||
          geometry.kind === 'radial-projectiles' ||
          geometry.kind === 'projectile-fan'
        ) {
          continue;
        }
        const zoneCircles =
          geometry.kind === 'circle'
            ? [geometry]
            : geometry.kind === 'spawn-circles' || geometry.kind === 'multi-circle'
              ? geometry.circles
              : [];
        for (const circle of zoneCircles) {
          if (maybeDodgeCircle(circle)) return BTStatus.SUCCESS;
        }
      }
      for (const zone of ctx.world.mobAbilities.activeZones) {
        if (maybeDodgeCircle(zone.circle)) return BTStatus.SUCCESS;
      }

      // Enemy-body dodging remains suspended during retreat and engagement:
      // their movement planners own spacing. Projectile dodging above is safe in
      // those states because it reacts to transient trajectories, not the target.
      if (this.decision.state === AIState.RETREAT || this.decision.state === AIState.ENGAGE) {
        return BTStatus.FAILURE;
      }

      // Travel heading for the path-blocking sidestep: prefer the vector to the
      // current Track A target, falling back to the previous-frame smoothed
      // output. With no meaningful heading there is no path to be blocked, so the
      // blocking branch is skipped (closing-speed dodge still runs).
      let headX = 0;
      let headY = 0;
      if (this.decision.targetX !== null && this.decision.targetY !== null) {
        headX = this.decision.targetX - ctx.playerX;
        headY = this.decision.targetY - ctx.playerY;
      }
      let headMag = Math.hypot(headX, headY);
      if (headMag < DETOUR_MIN_HEADING_MAGNITUDE) {
        headX = this.smoothMoveX;
        headY = this.smoothMoveY;
        headMag = Math.hypot(headX, headY);
      }
      const hasHeading = headMag >= DETOUR_MIN_HEADING_MAGNITUDE;
      if (hasHeading) {
        headX /= headMag;
        headY /= headMag;
      }

      const enemies = query(ctx.world.ecs, [Enemy, Position, Velocity, Health]);
      let closestThreatDist = Number.POSITIVE_INFINITY;
      let bestDodgeX = 0;
      let bestDodgeY = 0;
      let found = false;

      for (const eid of enemies) {
        if (eid === undefined) continue;
        const hp = ctx.world.stores.health.current[eid] ?? 0;
        if (hp <= 0) continue;

        const ex = ctx.world.stores.position.x[eid] ?? 0;
        const ey = ctx.world.stores.position.y[eid] ?? 0;
        if (!this.canPerceiveWorldPosition(ctx.world, ex, ey)) continue;
        const dist = Math.hypot(ex - ctx.playerX, ey - ctx.playerY);
        if (dist > DODGE_THREAT_RADIUS_FT) continue;

        const vx = ctx.world.stores.velocity.x[eid] ?? 0;
        const vy = ctx.world.stores.velocity.y[eid] ?? 0;
        // Unit vector from enemy toward player
        const toPlayerX = (ctx.playerX - ex) / (dist || 1);
        const toPlayerY = (ctx.playerY - ey) / (dist || 1);
        // Closing speed = component of enemy velocity in the toward-player direction
        const closingSpeed = vx * toPlayerX + vy * toPlayerY;
        const closing = closingSpeed >= DODGE_CLOSING_SPEED_FT_PER_FRAME;

        // Blocking = enemy parked just ahead on the travel path (forward cone),
        // close enough that the player would bulldoze into body contact.
        // Must satisfy: (1) enemy is in forward cone, (2) close enough, and
        // (3) enemy is actually between player and objective (closer to objective than to player).
        const aheadDot = ((ex - ctx.playerX) * headX + (ey - ctx.playerY) * headY) / (dist || 1);
        const ahead =
          hasHeading && dist <= DODGE_BLOCK_RADIUS_FT && aheadDot >= DODGE_BLOCK_AHEAD_DOT;

        if (!closing && !ahead) continue;
        if (dist >= closestThreatDist) continue;
        closestThreatDist = dist;

        if (closing) {
          // Perpendicular to enemy velocity: rotate 90° in orbit direction
          const speed = Math.hypot(vx, vy);
          if (speed > 0) {
            // (-vy, vx) rotates 90° CCW; (vy, -vx) rotates 90° CW
            // Use kiteOrbitSign to keep consistent dodge direction
            bestDodgeX = (-vy / speed) * this.kiteOrbitSign;
            bestDodgeY = (vx / speed) * this.kiteOrbitSign;
          }
        } else {
          // Sidestep perpendicular to the heading, toward whichever side the
          // enemy is NOT on, so the player curves around the obstacle.
          const cross = headX * (ey - ctx.playerY) - headY * (ex - ctx.playerX);
          const sign = cross > 0 ? -1 : 1;
          bestDodgeX = -headY * sign;
          bestDodgeY = headX * sign;
        }
        found = true;
      }

      if (!found) return BTStatus.FAILURE;

      this.dodgeVecX = bestDodgeX;
      this.dodgeVecY = bestDodgeY;
      return BTStatus.SUCCESS;
    });
  }

  /**
   * OpportunisticFarm: when Track A is genuinely wandering (EXPLORE with no
   * specific entity goal) and enemies are visible at wider range, add a pull
   * toward the nearest enemy cluster so auto-fire starts sooner.
   *
   * Decoupled from the loot detour: it writes its own `this.farmPullX/Y` blended
   * with {@link AIConfig.farmPullWeight} (default 0.12 = active). Enemy seeking
   * is ON by default since the 2026-07-22 promotion; pass `farmPullWeight: 0` to
   * suppress it. Higher values add more bias toward nearby enemies during wander.
   *
   * Critically: it only fires while moving (EXPLORE with a heading) and only
   * pulls toward enemies inside a forward cone ({@link FARM_FORWARD_DOT_MIN}
   * within {@link FARM_FORWARD_SCAN_RADIUS_FT}). This biases the player onto
   * swarm it is already approaching during quest-objective navigation without
   * ever dragging it backward toward ambient enemies — the reversal that
   * historically blew the floor-clear budget.
   */
  private buildOpportunisticFarm(): BTNode {
    return action('Opportunistic Farm', (ctx) => {
      if (this.isFloor2IntroductionPending(ctx.world)) return BTStatus.FAILURE;
      // Dormant unless a non-zero farm weight is configured; skip the enemy scan
      // entirely when the pull would be multiplied to nothing.
      if (this.config.farmPullWeight <= 0) return BTStatus.FAILURE;
      if (this.getCollapsePanicProfile(ctx.world).beeline) return BTStatus.FAILURE;

      // Surplus-time behavior only: a hurt runner skips the farm pull and beelines
      // its objective so it cannot drift onto more swarm and get overwhelmed.
      if (ctx.healthPercent < FARM_MIN_HEALTH_FRACTION) return BTStatus.FAILURE;

      // Only fire while traveling (EXPLORE), including EXPLORE used to navigate a
      // quest objective (targetEid !== null). It must never drag toward swarm
      // behind the player, so we require an enemy ahead inside a forward cone.
      if (this.decision.state !== AIState.EXPLORE) return BTStatus.FAILURE;

      // Heading = travel direction toward the current waypoint/objective. No
      // heading (standing still) ⇒ no forward cone ⇒ leave farming to others.
      if (this.decision.targetX === null || this.decision.targetY === null) {
        return BTStatus.FAILURE;
      }
      const hx = this.decision.targetX - ctx.playerX;
      const hy = this.decision.targetY - ctx.playerY;
      const hlen = Math.hypot(hx, hy);
      if (hlen < DETOUR_MIN_HEADING_MAGNITUDE) return BTStatus.FAILURE;
      const headX = hx / hlen;
      const headY = hy / hlen;

      const nearest = this.findNearestEnemy(
        ctx.world,
        ctx.playerX,
        ctx.playerY,
        FARM_FORWARD_SCAN_RADIUS_FT,
      );
      if (!nearest) return BTStatus.FAILURE;

      const dx = nearest.x - ctx.playerX;
      const dy = nearest.y - ctx.playerY;
      const dist = Math.hypot(dx, dy);
      if (dist <= 0) return BTStatus.FAILURE;

      // Forward cone: only pull toward enemies the player is already approaching.
      const dot = (dx / dist) * headX + (dy / dist) * headY;
      if (dot < FARM_FORWARD_DOT_MIN) return BTStatus.FAILURE;

      this.farmPullX = dx / dist;
      this.farmPullY = dy / dist;
      return BTStatus.SUCCESS;
    });
  }

  /**
   * Watchdog: abandon an ENGAGE target we cannot make progress against.
   *
   * Wiggling against a wall does not trip the per-frame stuck counter (net
   * displacement stays ~3px, comparable to normal travel), so we instead track
   * whether the gap to the target enemy is closing OR its HP is dropping. If
   * neither improves for {@link ENGAGE_GIVEUP_FRAMES}, the enemy is effectively
   * unreachable (e.g. behind a wall); blacklist it briefly so the behavior tree
   * retargets a reachable enemy instead of fixating forever.
   *
   * Baselines are tracked **per eid** ({@link engageBaselinesByEid}) while
   * {@link engageNoProgressFrames} is a **shared** counter that is NOT reset
   * when the tracked eid changes. This solves two classes of bug:
   *
   * 1. **Flicker deadlock** (weapon-sweep run 29453994290, bow-seed91/
   *    throwing-knife-seed14/throwing-knife-seed18): two enemies at a near-tied
   *    distance caused nearest-enemy selection to flip between them every tick,
   *    resetting the counter to 0 every frame so giveup was never reached.
   *    With a shared counter, any sustained no-progress stint counts toward
   *    giveup regardless of which eid is nominated each tick.
   *
   * 2. **False-positive blacklist** (code review finding): a global scalar
   *    baseline let a tight bar from enemy A (1 ft / 1 HP) carry over to
   *    enemy B (30 ft / 100 HP), making it impossible for real progress on B
   *    to be recognised until B beat A's unreachable minima. Per-eid baselines
   *    ensure each target is measured against its own history only.
   *
   * First-sight handling: the first call for a freshly-seen eid records the
   * current distance/HP as the baseline without affecting the counter (neither
   * progress nor no-progress). Progress is measured from the second call onward.
   */
  private updateEngageWatchdog(world: GameWorld, playerX: number, playerY: number): void {
    const eid = this.decision.targetEid;
    if (this.decision.state !== AIState.ENGAGE || eid === null) {
      this.engageNoProgressFrames = 0;
      this.engageBaselinesByEid.clear();
      return;
    }

    // Inside a safe room the weapon is hard-disabled, so the player can neither
    // close the final ft nor drop the enemy's HP. That is not "unreachable" —
    // the LeaveSafeRoom behavior is actively walking the player out. Resetting
    // the no-progress counter here prevents the watchdog from blacklisting the
    // entire wave (which would collapse Engage into a COLLECT wiggle deadlock).
    if (world.playerInSafeRoom) {
      this.engageNoProgressFrames = 0;
      this.engageBaselinesByEid.clear();
      return;
    }

    const ex = world.stores.position.x[eid];
    const ey = world.stores.position.y[eid];
    const hp = world.stores.health.current[eid];
    if (typeof ex !== 'number' || typeof ey !== 'number' || typeof hp !== 'number' || hp <= 0) {
      // Target despawned or died; let normal retargeting take over next tick.
      // Remove this eid's baseline entry so the next target isn't held to this
      // target's bar (e.g. a target killed at 1 ft would otherwise make a
      // fresh 30 ft enemy look like no progress).
      this.engageNoProgressFrames = 0;
      this.engageBaselinesByEid.delete(eid);
      return;
    }

    const dist = Math.hypot(ex - playerX, ey - playerY);

    const baseline = this.engageBaselinesByEid.get(eid);
    if (baseline === undefined) {
      // First time seeing this eid: record its starting position/HP as the
      // baseline. Don't affect the counter — there is no history to compare
      // against yet, so neither a progress-reset nor a no-progress increment
      // would be meaningful.
      this.engageBaselinesByEid.set(eid, { bestDistance: dist, bestHp: hp });
      return;
    }

    let progressed = false;
    if (dist < baseline.bestDistance - ENGAGE_PROGRESS_EPSILON_FT) {
      baseline.bestDistance = dist;
      progressed = true;
    }
    if (hp < baseline.bestHp) {
      baseline.bestHp = hp;
      progressed = true;
    }

    if (progressed) {
      this.engageNoProgressFrames = 0;
      return;
    }

    this.engageNoProgressFrames++;
    if (this.engageNoProgressFrames > ENGAGE_GIVEUP_FRAMES) {
      this.ignoredEnemyUntilFrame.set(eid, world.frameCount + ENEMY_IGNORE_FRAMES);
      this.decision.targetEid = null;
      this.decision.targetX = null;
      this.decision.targetY = null;
      this.pathWaypoints = [];
      this.pathIndex = 0;
      this.pathGoalKey = null;
      this.engageNoProgressFrames = 0;
      this.engageBaselinesByEid.clear();
      if (this.config.debug) {
        logger.debug(`AI abandoning unreachable enemy ${String(eid)} (no progress)`);
      }
    }
  }

  /**
   * Blacklist every loot pile (XP gem, gold, dropped item) within {@param radius}
   * ft of the given point for {@link LOOT_IGNORE_FRAMES}. Used by the COLLECT dwell
   * watchdog to abandon an entire cluster of mutually-unreachable loot at once,
   * rather than one entity at a time (which lets the AI rotate forever between
   * neighbours in the same cluster).
   *
   * @returns the number of loot piles blacklisted.
   */
  private blacklistLootCluster(
    world: GameWorld,
    centerX: number,
    centerY: number,
    radius: number,
  ): number {
    const radiusSq = radius * radius;
    const expireFrame = world.frameCount + LOOT_IGNORE_FRAMES;
    let count = 0;
    const lootEntities = [
      ...query(world.ecs, [XpGem, Position]),
      ...query(world.ecs, [Gold, Position]),
      ...query(world.ecs, [DroppedItem, Position]),
    ];
    for (const eid of lootEntities) {
      if (eid === undefined) continue;
      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= radiusSq) {
        this.ignoredLootUntilFrame.set(eid, expireFrame);
        count++;
      }
    }
    return count;
  }

  /**
   * True when the player is parked on a harvestable node (within
   * {@link HARVEST_RANGE_FT}) so `harvestSystem` is accruing progress this frame.
   * The harvest is deliberately stationary, so the dwell watchdogs must read it
   * as progress and re-anchor — otherwise they would abandon/blacklist a node
   * before its 2.5–4 s timer completes.
   */
  private isActivelyHarvesting(world: GameWorld, playerX: number, playerY: number): boolean {
    const nodes = query(world.ecs, [Harvestable, Position]);
    const rangeSq = HARVEST_RANGE_FT * HARVEST_RANGE_FT;
    for (const eid of nodes) {
      if (eid === undefined) continue;
      const nx = world.stores.position.x[eid] ?? 0;
      const ny = world.stores.position.y[eid] ?? 0;
      const dx = playerX - nx;
      const dy = playerY - ny;
      if (dx * dx + dy * dy <= rangeSq) {
        return true;
      }
    }
    return false;
  }

  /**
   * Watchdog: break out of a COLLECT deadlock against an unreachable loot cluster.
   *
   * A per-target distance watchdog is defeated when the AI rotates between several
   * mutually-unreachable gems clustered at e.g. a safe-room boundary: each target
   * switch resets the per-target counter before it can fire, and per-frame stuck
   * detection is fooled by wiggle (net displacement stays a few ft while the player
   * oscillates). So we track the player's NET displacement while it is continuously
   * in COLLECT. If the player never escapes a small dwell circle for
   * {@link COLLECT_DWELL_FRAMES}, the whole nearby cluster is unreachable — blacklist
   * every pile inside {@link COLLECT_DWELL_CLUSTER_RADIUS_FT} so the tree drops
   * through COLLECT to Hunt/Explore and makes real progress.
   */
  private updateCollectWatchdog(world: GameWorld, playerX: number, playerY: number): void {
    if (this.decision.state !== AIState.COLLECT) {
      this.collectDwellActive = false;
      this.collectDwellFrames = 0;
      return;
    }

    // A harvestable takes a few seconds of stationary proximity to gather, so a
    // legitimately-harvesting AI nets ~zero displacement on purpose. Treat active
    // harvesting as progress: re-anchor instead of blacklisting the node mid-pull.
    if (this.isActivelyHarvesting(world, playerX, playerY)) {
      this.collectDwellActive = true;
      this.collectDwellAnchorX = playerX;
      this.collectDwellAnchorY = playerY;
      this.collectDwellFrames = 0;
      return;
    }

    if (!this.collectDwellActive) {
      this.collectDwellActive = true;
      this.collectDwellAnchorX = playerX;
      this.collectDwellAnchorY = playerY;
      this.collectDwellFrames = 0;
      return;
    }

    const drift = Math.hypot(
      playerX - this.collectDwellAnchorX,
      playerY - this.collectDwellAnchorY,
    );
    if (drift > COLLECT_DWELL_ESCAPE_FT) {
      // Player netted real travel out of the dwell circle — it is making progress,
      // so re-anchor and keep collecting.
      this.collectDwellAnchorX = playerX;
      this.collectDwellAnchorY = playerY;
      this.collectDwellFrames = 0;
      return;
    }

    this.collectDwellFrames++;
    if (this.collectDwellFrames > COLLECT_DWELL_FRAMES) {
      const blacklisted = this.blacklistLootCluster(
        world,
        playerX,
        playerY,
        COLLECT_DWELL_CLUSTER_RADIUS_FT,
      );
      this.decision.targetEid = null;
      this.decision.targetX = null;
      this.decision.targetY = null;
      this.pathWaypoints = [];
      this.pathIndex = 0;
      this.pathGoalKey = null;
      this.collectDwellActive = false;
      this.collectDwellFrames = 0;
      if (this.config.debug) {
        logger.debug(
          `AI abandoning unreachable loot cluster (${String(blacklisted)} piles, dwell ${String(COLLECT_DWELL_FRAMES)}f)`,
        );
      }
    }
  }

  /**
   * Watchdog: break out of an EXPLORE deadlock against an unreachable frontier.
   *
   * {@link pickExploreTarget} chooses a random passable tile and the Explore node
   * only re-picks once the player closes within 50px of it. When that tile is
   * unreachable (behind a locked door, across an unpathable gap) the player wiggles
   * against the obstacle indefinitely and never re-picks. The per-frame stuck
   * counter in {@link poll} is defeated by the wiggle (net displacement stays above
   * its epsilon). So we track the player's NET displacement while continuously in
   * EXPLORE: if it never escapes a small dwell circle for {@link EXPLORE_DWELL_FRAMES},
   * the current frontier is unreachable — clear it so the Explore node selects a
   * fresh target next tick.
   */
  private updateExploreWatchdog(
    world: GameWorld,
    playerX: number,
    playerY: number,
    currentFrame: number,
  ): void {
    if (this.decision.state !== AIState.EXPLORE) {
      this.exploreDwell.reset();
      return;
    }

    if (this.exploreDwell.update(playerX, playerY) !== 'fired') {
      return;
    }

    // Parked against an unreachable frontier for the full window: drop it so the
    // Explore node re-rolls a new target next tick.
    this.decision.targetX = null;
    this.decision.targetY = null;
    this.pathWaypoints = [];
    this.pathIndex = 0;
    this.pathGoalKey = null;
    // If the frozen target was a position-based progress goal (non-enemy,
    // e.g. Tutorial Goon, Shopkeeper, boss room), suppress ALL
    // position progress goals temporarily. Without this the BT immediately
    // re-assigns the same unreachable position on the next frame, the dwell
    // counter resets to 0, and the AI freezes forever without ever fighting.
    const targetEid = this.decision.targetEid;
    const fixedPositionProgressTarget =
      targetEid === null ||
      targetEid < 0 ||
      // Only suppress for NPC-backed progress goals (Tutorial Goon, Shopkeeper,
      // etc.). Gold piles, dropped items, and Floor-2 resource targets are also
      // non-enemy entity-backed but must not start the progress suppression window
      // — they are not stuck navigation targets, just collectible goals that may
      // temporarily be unreachable.
      (targetEid >= 0 &&
        hasComponent(world.ecs, targetEid, Npc) &&
        !hasComponent(world.ecs, targetEid, Enemy));
    if (fixedPositionProgressTarget) {
      this.progressGoalSuppressedUntilFrame = currentFrame + PROGRESS_SUPPRESS_FRAMES;
      this.progressGoalSuppressionSource =
        targetEid === null
          ? AIProgressSuppressionSource.EXPLORE_DWELL_FRONTIER_TARGET
          : AIProgressSuppressionSource.EXPLORE_DWELL_FIXED_POSITION_TARGET;
    }
    if (this.config.debug) {
      logger.debug(
        `AI abandoning unreachable explore frontier (dwell ${String(EXPLORE_DWELL_FRAMES)}f)`,
      );
    }
  }

  /**
   * State-agnostic watchdog: break ANY parked-in-place deadlock, including the
   * cross-state thrash the per-state dwell watchdogs structurally cannot catch.
   *
   * The engage/collect/explore dwell watchdogs each reset the instant their
   * state stops running. When the tree flip-flops between two states every frame
   * (e.g. an enemy oscillating A*-reachable/unreachable as the player wiggles a
   * few ft across a tile edge at a doorway choke, so it alternates ENGAGE one way
   * and COLLECT the other), each switch zeroes the *other* counter, none ever
   * accumulate, and the player vibrates in place forever (observed 400s+).
   *
   * This runs every poll regardless of state. It anchors the player's position
   * and only re-anchors on genuine progress: real net travel, closing on the
   * nearest reachable enemy, OR damaging the local wave (total nearby enemy HP
   * drops — so legitimate stationary combat is never mistaken for a deadlock).
   * If none happen for {@link GLOBAL_DWELL_FRAMES}, the player is wedged:
   * blacklist the local enemy wave and loot cluster it is thrashing over and
   * clear its target, forcing the tree through to (reachability-aware) Explore,
   * which relocates the player to fresh ground from which the wave can be
   * approached — or simply lets auto-fire mow the wave as it gives chase.
   */
  private updateGlobalDwellWatchdog(world: GameWorld, playerX: number, playerY: number): void {
    // Inside a safe room the weapon is disabled and LeaveSafeRoom is actively
    // walking the player out — not a deadlock. Reset so it cannot false-fire.
    if (world.playerInSafeRoom) {
      this.globalDwellActive = false;
      this.globalDwellFrames = 0;
      return;
    }

    const nearest = this.findNearestEnemy(world, playerX, playerY);
    const nearestDist = nearest ? nearest.distance : Number.POSITIVE_INFINITY;
    const nearbyHp = this.sumNearbyEnemyHp(world, playerX, playerY);

    if (!this.globalDwellActive) {
      this.globalDwellActive = true;
      this.globalDwellAnchorX = playerX;
      this.globalDwellAnchorY = playerY;
      this.globalDwellFrames = 0;
      this.globalDwellBestEnemyDist = nearestDist;
      this.globalDwellBestEnemyHp = nearbyHp;
      return;
    }

    // Standing still to harvest a resource node is intentional progress, not a
    // wedge — re-anchor so the cross-state watchdog never relocates the AI off a
    // node it is mid-harvest on.
    if (this.isActivelyHarvesting(world, playerX, playerY)) {
      this.globalDwellAnchorX = playerX;
      this.globalDwellAnchorY = playerY;
      this.globalDwellFrames = 0;
      this.globalDwellBestEnemyDist = nearestDist;
      this.globalDwellBestEnemyHp = nearbyHp;
      return;
    }

    const drift = Math.hypot(playerX - this.globalDwellAnchorX, playerY - this.globalDwellAnchorY);
    const closedOnEnemy =
      nearestDist < this.globalDwellBestEnemyDist - GLOBAL_DWELL_ENEMY_PROGRESS_FT;
    const dealtDamage = nearbyHp < this.globalDwellBestEnemyHp - ENGAGE_PROGRESS_EPSILON_FT;

    if (drift > GLOBAL_DWELL_ESCAPE_FT || closedOnEnemy || dealtDamage) {
      this.globalDwellAnchorX = playerX;
      this.globalDwellAnchorY = playerY;
      this.globalDwellFrames = 0;
      this.globalDwellBestEnemyDist = nearestDist;
      this.globalDwellBestEnemyHp = nearbyHp;
      return;
    }

    this.globalDwellFrames++;
    if (this.globalDwellFrames <= GLOBAL_DWELL_FRAMES) {
      return;
    }

    // Wedged with zero net progress for the full window: blast the local wave +
    // loot cluster so the tree falls through to Explore and the player relocates.
    const blacklisted = this.relocateFromStall(world, playerX, playerY);

    this.globalDwellActive = false;
    this.globalDwellFrames = 0;
    if (this.config.debug) {
      logger.debug(
        `AI global dwell watchdog fired: relocating (loot ${String(blacklisted)} piles, dwell ${String(GLOBAL_DWELL_FRAMES)}f)`,
      );
    }
  }

  /**
   * Shared deadlock remediation used by the global-dwell and quest-progress
   * watchdogs: ignore the local enemy wave (within engage radius) + the loot
   * cluster underfoot and drop the current decision target/path so the BT falls
   * through to Explore and the player physically relocates. Returns the number
   * of loot piles blacklisted (for debug logging).
   */
  private relocateFromStall(world: GameWorld, playerX: number, playerY: number): number {
    const expireEnemy = world.frameCount + ENEMY_IGNORE_FRAMES;
    const engageRadius = this.getEngageRadius(world);
    const radiusSq = engageRadius * engageRadius;
    const enemies = query(world.ecs, [Enemy, Position, Health]);
    for (const eid of enemies) {
      if (eid === undefined) continue;
      const hp = world.stores.health.current[eid] ?? 0;
      if (hp <= 0) continue;
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      if (!this.canPerceiveWorldPosition(world, ex, ey)) continue;
      const dx = ex - playerX;
      const dy = ey - playerY;
      if (dx * dx + dy * dy <= radiusSq) {
        this.ignoredEnemyUntilFrame.set(eid, expireEnemy);
      }
    }
    const blacklisted = this.blacklistLootCluster(
      world,
      playerX,
      playerY,
      COLLECT_DWELL_CLUSTER_RADIUS_FT,
    );

    this.decision.targetEid = null;
    this.decision.targetX = null;
    this.decision.targetY = null;
    this.pathWaypoints = [];
    this.pathIndex = 0;
    this.pathGoalKey = null;
    this.engageNoProgressFrames = 0;

    return blacklisted;
  }

  /**
   * Coarse, near-monotonic "floor progress" score for this world — see
   * {@link computeFloorProgressScore}, which holds the (pure, unit-tested)
   * scoring. It advances on ANY real quest objective tick, completion, or gold
   * payout but stays frozen during a knockback/kite deadlock, which is exactly
   * why the quest-progress watchdog keys on it.
   */
  private computeFloorProgressFingerprint(world: GameWorld): number {
    return computeFloorProgressScore(world.questLog.values(), world.playerGold);
  }

  /**
   * Floor-progress stall backstop. The global-dwell watchdog re-anchors on
   * spatial drift and nearby-enemy chip damage, so a knockback/kite loop — the
   * bat punts a quest enemy just out of reach and the wedged player chases it in
   * a tight orbit, landing chip hits but never the kill — keeps it alive forever
   * (observed: ~188s pinned, kills frozen, a "4g to go" gold-farm goal that never
   * resolves). This watchdog instead keys on
   * {@link computeFloorProgressFingerprint}, which only advances on a real
   * objective tick / completion / gold payout, so a deadlock trips it while
   * legitimately slow combat (which still drips gold + kills) does not.
   */
  private updateQuestProgressWatchdog(world: GameWorld, playerX: number, playerY: number): void {
    if (world.state !== 'playing') {
      this.questProgressActive = false;
      this.questProgressStallFrames = 0;
      return;
    }

    const score = this.computeFloorProgressFingerprint(world);

    if (!this.questProgressActive) {
      this.questProgressActive = true;
      this.questProgressBestScore = score;
      this.questProgressStallFrames = 0;
      return;
    }

    if (score > this.questProgressBestScore) {
      this.questProgressBestScore = score;
      this.questProgressStallFrames = 0;
      return;
    }

    this.questProgressStallFrames++;
    if (this.questProgressStallFrames <= QUEST_PROGRESS_STALL_FRAMES) {
      return;
    }

    // An active boss battle legitimately freezes the fingerprint (a single
    // binary "defeat the boss" objective, no add payouts) for the length of the
    // whittle. Relocating mid-fight would abandon the boss, so hold the timer
    // while the boss quest is live and an enemy is actually in range.
    const bossQuest = world.questLog.get(FLOOR1_BOSS_BATTLE_QUEST_ID);
    const nearestEnemy = this.findNearestEnemy(world, playerX, playerY);
    if (bossQuest?.status === 'active' && nearestEnemy) {
      this.questProgressStallFrames = 0;
      return;
    }

    const blacklisted = this.relocateFromStall(world, playerX, playerY);
    // The wedge is usually a swarm pinned against an unreachable fixed goal (NPC
    // / coin pile), so suppress position-based progress goals too and let
    // Hunt/Explore take the wheel until the player has relocated.
    this.progressGoalSuppressedUntilFrame = world.frameCount + ENEMY_IGNORE_FRAMES;
    this.progressGoalSuppressionSource = AIProgressSuppressionSource.QUEST_PROGRESS_DWELL_WATCHDOG;
    this.questProgressActive = false;
    this.questProgressStallFrames = 0;
    if (this.config.debug) {
      logger.debug(
        `AI quest-progress watchdog fired: relocating (loot ${String(blacklisted)} piles, stall ${String(QUEST_PROGRESS_STALL_FRAMES)}f)`,
      );
    }
  }

  /**
   * Total current HP of all living enemies within engage radius of the player.
   * Used by {@link updateGlobalDwellWatchdog} as a "dealing damage" progress
   * signal: while auto-fire chews down a wave the player is standing in, this
   * keeps dropping every frame, so the watchdog re-anchors and never mistakes
   * legitimate stationary combat for a wedged deadlock.
   */
  private sumNearbyEnemyHp(world: GameWorld, playerX: number, playerY: number): number {
    const engageRadius = this.getEngageRadius(world);
    const radiusSq = engageRadius * engageRadius;
    const enemies = query(world.ecs, [Enemy, Position, Health]);
    let sum = 0;
    for (const eid of enemies) {
      if (eid === undefined) continue;
      const hp = world.stores.health.current[eid] ?? 0;
      if (hp <= 0) continue;
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      if (!this.canPerceiveWorldPosition(world, ex, ey)) continue;
      const dx = ex - playerX;
      const dy = ey - playerY;
      if (dx * dx + dy * dy <= radiusSq) {
        sum += hp;
      }
    }
    return sum;
  }

  private invalidateTransientDecisionForHostileEncounter(world: GameWorld): void {
    this.observedHostileEncounterRevision = world.hostileEncounterRevision;
    this.hostileEncounterInvalidationCount += 1;
    this.lastHostileEncounterInvalidationFrame = world.frameCount;
    this.decision = {
      state: AIState.EXPLORE,
      targetEid: null,
      targetX: null,
      targetY: null,
      reason: 'Hostile encounter activated',
      npcInteraction: null,
      debug: null,
    };
    this.pathWaypoints = [];
    this.pathIndex = 0;
    this.pathGoalKey = null;
    this.moveWedgeFrames = 0;
    this.stuckFrames = 0;
    this.smoothMoveX = 0;
    this.smoothMoveY = 0;
    this.ignoredEnemyUntilFrame.clear();
    this.targetReachableCache.clear();
    this.engageNoProgressFrames = 0;
    this.engageBaselinesByEid.clear();
    this.collectDwellActive = false;
    this.collectDwellFrames = 0;
    this.exploreDwell.reset();
    this.progressGoalSuppressedUntilFrame = 0;
    this.progressGoalSuppressionSource = null;
    this.pendingSuppressedProgressNavDebug = null;
    this.floor2HuntMap = null;
    this.floor2HuntFamilyId = null;
    this.floor2HuntPatrolIndex = 0;
    this.floor2HuntPatrolTarget = null;
    this.floor2HuntLastKillCount = 0;
    this.floor2HuntLastProgressFrame = world.frameCount;
    this.floor2HuntCadenceStartFrame = world.frameCount;
    this.floor2HuntHandledSuppressionUntilFrame = 0;
    this.floor2HuntPatrolTiles.clear();
    this.xpCleanupMode = null;
    this.xpCleanupAnchorX = 0;
    this.xpCleanupAnchorY = 0;
    this.xpCleanupStartFrame = 0;
    this.xpCleanupCooldownUntilFrame = 0;
    this.xpCleanupCombatWindowUntilFrame = -1;
    this.globalDwellActive = false;
    this.globalDwellFrames = 0;
    this.questProgressActive = false;
    this.questProgressStallFrames = 0;
    this.retreating = false;
    this.rangedEmergencyRetreating = false;
    this.rangedDefensiveSpacing = false;
    this.retreatTargetX = null;
    this.retreatTargetY = null;
    this.retreatThreatEid = null;
    this.lastArenaLockinEid = null;
    this.lastArenaLockinKind = null;
    this.opportunisticPullX = 0;
    this.opportunisticPullY = 0;
    this.farmPullX = 0;
    this.farmPullY = 0;
    this.dodgeVecX = 0;
    this.dodgeVecY = 0;
    this.prevFusedDirX = 0;
    this.prevFusedDirY = 0;
    this.lastTravelSteering = null;
    this.lastRunPlan = null;
    this.lastTacticalOpportunityEvaluation = null;
    this.tacticalTravelOwnsLoot = false;
  }

  poll(state: InputState, world: GameWorld): void {
    setPreferredWeaponTarget(world, null);
    if (world.hostileEncounterRevision !== this.observedHostileEncounterRevision) {
      this.invalidateTransientDecisionForHostileEncounter(world);
    }
    this.pendingSuppressedProgressNavDebug = null;
    this.decision.npcInteraction = null;
    this.decision.debug = null;
    if (world.frameCount >= this.progressGoalSuppressedUntilFrame) {
      this.progressGoalSuppressionSource = null;
    }

    // Find player entity
    const playerEntities = query(world.ecs, [Player, Position, Health]);
    if (playerEntities.length === 0) {
      // No player - neutral input
      state.moveX = 0;
      state.moveY = 0;
      state.action = false;
      return;
    }

    const playerEid = playerEntities[0];
    if (playerEid === undefined) {
      state.moveX = 0;
      state.moveY = 0;
      state.action = false;
      return;
    }

    const playerX = world.stores.position.x[playerEid] ?? 0;
    const playerY = world.stores.position.y[playerEid] ?? 0;
    const playerHealth = world.stores.health.current[playerEid] ?? 1;
    const playerMaxHealth = world.stores.health.max[playerEid] ?? 1;
    const healthPercent = playerHealth / playerMaxHealth;
    this.updateSafeRoomEgressWaypointLatch(world, playerX, playerY);

    // Update stuck detection. Standing on a harvestable to gather it nets ~zero
    // displacement on purpose, so suppress the stuck counter while harvesting —
    // otherwise the >60f loot-blacklist below would abandon the node mid-gather.
    const dist = Math.hypot(playerX - this.lastPlayerX, playerY - this.lastPlayerY);
    this.stuckFrames = this.isActivelyHarvesting(world, playerX, playerY)
      ? 0
      : nextStuckFrames(this.stuckFrames, dist, STUCK_PROGRESS_EPSILON_FT);
    this.lastPlayerX = playerX;
    this.lastPlayerY = playerY;

    // If stuck for too long, clear path and pick new goal. NOTE: stuckFrames is
    // a weak signal — at ~0.375ft/frame normal travel it can climb even while moving
    // productively, so enemy abandonment is handled by updateEngageWatchdog
    // (real distance/HP progress) rather than here. We only blacklist loot here.
    if (this.stuckFrames > 60) {
      // Blacklist whatever loot we are wedged against so we stop re-selecting it.
      // This covers gold collected via the normal COLLECT node *and* gold being
      // farmed for the merchant charm, which routes through Progress (state
      // EXPLORE, but still carries the Gold entity's eid). Without the Gold check
      // an unreachable coin pile deadlocks the ready-to-buy stage indefinitely.
      const stuckEid = this.decision.targetEid;
      if (
        stuckEid !== null &&
        stuckEid >= 0 &&
        (this.decision.state === AIState.COLLECT || hasComponent(world.ecs, stuckEid, Gold))
      ) {
        this.ignoredLootUntilFrame.set(stuckEid, world.frameCount + LOOT_IGNORE_FRAMES);
      }
      this.pathWaypoints = [];
      this.pathGoalKey = null;
      this.stuckFrames = 0;
      if (this.config.debug) {
        logger.debug('AI stuck, clearing path');
      }
    }

    // Abandon ENGAGE targets we cannot make progress against (wall-blocked).
    this.updateEngageWatchdog(world, playerX, playerY);

    // Abandon COLLECT loot we cannot make progress toward (wall-blocked / wedged
    // against a safe-room boundary). Without this the AI fixates on an
    // unreachable gem forever, wiggling in place (the per-frame stuck counter
    // never trips because wiggle keeps net displacement above its epsilon).
    this.updateCollectWatchdog(world, playerX, playerY);

    // Abandon EXPLORE frontiers we cannot reach (behind a locked door or across an
    // unpathable gap). Without this the AI wiggles against the obstacle forever,
    // never re-picking because it never closes within 50px of the target.
    this.updateExploreWatchdog(world, playerX, playerY, world.frameCount);

    // State-agnostic backstop: break cross-state thrash (ENGAGE<->COLLECT every
    // frame at a navigation choke) that none of the per-state watchdogs above can
    // catch, since each resets the instant its state stops running.
    this.updateGlobalDwellWatchdog(world, playerX, playerY);

    // Floor-progress backstop: catch knockback/kite deadlocks where the player
    // jitters in place landing chip hits but no kills, so neither the per-state
    // nets nor the global-dwell drift/HP watchdog ever fire. Keyed on quest
    // objective + gold progress, which a real deadlock leaves frozen.
    this.updateQuestProgressWatchdog(world, playerX, playerY);
    this.refreshQuestAcceptanceNavigation(world);

    // Refresh door-aware navigation each poll: closed-but-openable doors become
    // passable for A*, while locked-unsatisfied doors stay walls. Rebuilding
    // here picks up unlock conditions the player has just satisfied.
    this.refreshDoorNavigation(world);

    // Refresh the deterministic player→staircase travel-time estimate so the
    // collapse-panic profile can consult it during this poll's tree.tick. Runs
    // only in the post-unlock/pre-discovery phase; A* is throttled to
    // OBJECTIVE_TRAVEL_ASTAR_REFRESH_TICKS frames.
    this.refreshPlayerToStairsTravelEstimate(
      world,
      playerX,
      playerY,
      this.getPlayerSpeedFtPerFrame(world, playerEid),
    );

    // FloorMap already maintains the same persistent tile-level discovery memory
    // that the AI used to rebuild by scanning the entire map every poll.
    this.hasPerceptionData ||= world.floorMap?.hasVisibleTiles() ?? false;

    // Reset opportunistic vectors from Track B so stale data never carries over.
    this.opportunisticPullX = 0;
    this.opportunisticPullY = 0;
    this.farmPullX = 0;
    this.farmPullY = 0;
    this.dodgeVecX = 0;
    this.dodgeVecY = 0;
    this.lastRunPlan = null;
    this.lastTacticalOpportunityEvaluation = null;
    this.tacticalTravelOwnsLoot = false;

    const merchantWeaponIntent = getMerchantWeaponIntent(world);
    const playerSpeedFtPerFrame = this.getPlayerSpeedFtPerFrame(world, playerEid);
    if (merchantWeaponIntent.enabled) {
      this.getMerchantDecisionRunPlan(world, playerEid, playerX, playerY, playerSpeedFtPerFrame);
    } else {
      this.merchantDecisionRunPlan = null;
      this.merchantDecisionRunPlanFrame = -Infinity;
    }

    // Build context for behavior tree
    const context: BTContext = {
      world,
      playerEid,
      playerX,
      playerY,
      healthPercent,
      frameCount: world.frameCount,
      blackboard: {},
    };

    this.npcApproachThreatProgressEvaluatedThisPoll = false;

    // Unconditional per-poll settlement-return-router state update, run
    // BEFORE the tree ticks — see `settlement-return-router.ts`'s
    // `updateSettlementReturnIntent` doc for why this must run before (not
    // after, unlike the merchant-weapon-intent precedent above) the tree
    // evaluates any branch: a danger-abort transition must already be
    // committed by the time `findFloor2ProgressObjective` (if reached this
    // same tick) reads the router's status. Reuses the SAME threat
    // definition Retreat/Engage use (`findNearestEnemy`/`getEngageRadius`)
    // and the SAME dwell-watchdog flag every sibling fixed-goal Progress
    // branch already reads, so there is exactly one "danger"/"unreachable"
    // definition, not a second one that could disagree.
    //
    // Gated on `isSettlementReturnRoutingEnabled` (a cheap WeakMap read):
    // `updateSettlementReturnIntent` itself already no-ops with zero side
    // effects when disabled (the default), but by then the threat scan/
    // engage-radius/settlement-anchor lookups below would already have been
    // computed and thrown away every single poll. Skipping the whole block
    // when disabled is behaviorally identical (the disabled path never
    // mutates `routerStates`) while avoiding that wasted per-frame cost.
    if (isSettlementReturnRoutingEnabled(world)) {
      const nearestThreatForSettlementReturn = this.findNearestEnemy(world, playerX, playerY);
      const engageRadiusForSettlementReturn = this.getEngageRadius(world);
      const dangerNearbyForSettlementReturn =
        nearestThreatForSettlementReturn !== null &&
        nearestThreatForSettlementReturn.distance <= engageRadiusForSettlementReturn;
      const progressSuppressedForSettlementReturn =
        world.frameCount < this.progressGoalSuppressedUntilFrame;
      updateSettlementReturnIntent(
        world,
        playerEid,
        playerX,
        playerY,
        resolveFloor2SettlementAnchor(world),
        dangerNearbyForSettlementReturn,
        progressSuppressedForSettlementReturn,
      );
    }

    // Execute behavior tree (Track A sets this.decision; Track B writes
    // opportunisticPullX/Y and dodgeVecX/Y as side-effects)
    this.tree.tick(context);
    if (merchantWeaponIntent.enabled) {
      const validatedMerchantPlan = this.getMerchantDecisionRunPlan(
        world,
        playerEid,
        playerX,
        playerY,
        playerSpeedFtPerFrame,
      );
      updateMerchantWeaponIntent(world, validatedMerchantPlan, RUN_PLANNER_GOLD_FARM_MS);
    }
    if (!this.npcApproachThreatProgressEvaluatedThisPoll) {
      this.resetNpcApproachThreatTracking();
    }

    // Pathing axis 1: RISK_REWARD_FUSED is the sole current arm — scores candidate
    // headings by objective progress, reward pull, and sampled overlap-danger.
    const useFused = this.config.pathingMode === AIPathingMode.RISK_REWARD_FUSED;

    // Execute decision: move toward target (Track A direction)
    if (this.decision.targetX !== null && this.decision.targetY !== null) {
      this.moveToward(state, world, playerX, playerY, this.decision.targetX, this.decision.targetY);
    } else {
      state.moveX = 0;
      state.moveY = 0;
    }

    // Track B (reward pull) is blended differently per mode: LEGACY blends it
    // additively AFTER travel steering (below); the fused scorer folds Track A +
    // Track B into a single danger-aware heading HERE, before travel steering.
    // `weights` is poll-invariant (getCollapsePanicProfile + static config,
    // independent of anything travel steering mutates) so hoisting it above travel
    // steering keeps LEGACY byte-identical.
    const weights = this.getDynamicOpportunisticWeights(world);
    let fusedYieldedZero = false;
    if (useFused) {
      // A/B pathing mode B: score candidate headings by objective progress,
      // reward pull, and sampled overlap-danger so the AI prefers low-risk seams
      // when moving through enemy pressure fields. The local safe-gap travel
      // controller below then executes on this fused intent.
      const fused = this.computeRiskRewardFusedHeading(
        world,
        playerX,
        playerY,
        state.moveX,
        state.moveY,
        weights,
      );
      state.moveX = fused.moveX;
      state.moveY = fused.moveY;
      // The fused scorer only folds Track B (reward pull) into a REAL heading. When
      // it yields {0,0} (no travel target this poll — e.g. a ranged AI between
      // shots) it folded nothing in, so the additive Track B blend below must still
      // run to pass dodge/pull through; otherwise the player freezes for the frame
      // instead of sidestepping threats the way LEGACY does (code review 2026-07-08).
      fusedYieldedZero = fused.moveX === 0 && fused.moveY === 0;
    }

    // Predictive safe-gap travel steering: for travel states, replace the raw
    // objective heading (Track A) with a safe, forward-progressing arc that
    // *dances around* perceived mobs — generalizing the ENGAGE kite's spacing to
    // travel. Damage-agnostic (nothing here reads a hostile-damage multiplier).
    let travelEmergency = false;
    this.lastTravelSteering = null;
    if (TRAVEL_STEERING_ENABLED && this.shouldTravelSteer(playerX, playerY)) {
      const objMag = Math.hypot(state.moveX, state.moveY);
      if (objMag > TRAVEL_HEADING_EPSILON) {
        const steer = this.computeTravelSteering(
          world,
          playerEid,
          playerX,
          playerY,
          state.moveX,
          state.moveY,
        );
        state.moveX = steer.moveX;
        state.moveY = steer.moveY;
        travelEmergency = steer.emergency;
        this.lastTravelSteering = steer;
        if (this.tacticalTravelOwnsLoot) {
          this.opportunisticPullX = 0;
          this.opportunisticPullY = 0;
          this.farmPullX = 0;
          this.farmPullY = 0;
        }
        const preserveMobAbilityDodge =
          world.mobAbilities.cues.length > 0 ||
          world.mobAbilities.activeZones.some((zone) => {
            const dx = playerX - zone.circle.x;
            const dy = playerY - zone.circle.y;
            return dx * dx + dy * dy <= zone.circle.radiusFt * zone.circle.radiusFt;
          }) ||
          world.mobAbilities.ownedZones.some((zone) => {
            const zoneCircles =
              zone.geometry.kind === 'circle'
                ? [zone.geometry]
                : zone.geometry.kind === 'multi-circle'
                  ? zone.geometry.circles
                  : [];
            return zoneCircles.some((circle) => {
              const dx = playerX - circle.x;
              const dy = playerY - circle.y;
              return dx * dx + dy * dy <= circle.radiusFt * circle.radiusFt;
            });
          });
        // The steering heading already encodes predictive spacing; blending the
        // legacy single-closest-threat dodge on top would double-count and
        // reintroduce the oscillation that widening it caused (commit f4f538d7),
        // so retire the additive travel dodge whenever steering drives the frame.
        // Mob-ability danger cues are different: their committed geometry is not
        // represented in travel steering, so preserve that dodge contribution.
        // This covers every live cue phase, not just `telegraph` — the Clockwork
        // Kill-Saw stays lethal through `outbound`/`hold`/`return`, so zeroing the
        // dodge once the telegraph ends would walk the AI into the moving blade.
        // Slick-zone occupancy: if the player is currently inside an active zone,
        // the zone-branch dodge vector must also be preserved so the AI exits
        // rather than walking through the slick after travel steering takes over.
        // Runtime-owned zones need the same protection so travel steering does
        // not wipe the outward cloud/surface dodge it just computed earlier.
        if (!preserveMobAbilityDodge) {
          this.dodgeVecX = 0;
          this.dodgeVecY = 0;
        }
      }
    }

    // Blend Track B opportunistic vectors additively into the Track A direction.
    // The result is re-normalized to unit length if it exceeds 1 so the player
    // moves at full speed regardless of blend magnitudes. The loot-detour pull
    // and the (default-dormant) enemy-farm pull ride independent weights.
    //
    // LEGACY blends AFTER travel steering. In RISK_REWARD_FUSED mode the fused
    // scorer above already folded Track B (reward pull) into the heading, so
    // re-blending here would double-count it — skip the additive blend when fused,
    // EXCEPT when the fused scorer produced no heading (fusedYieldedZero): it
    // folded nothing in that poll, so the blend runs to pass dodge/pull through.
    if (!useFused || fusedYieldedZero) {
      const blend = this.blendWithTrackB(state.moveX, state.moveY, weights);
      state.moveX = blend.moveX;
      state.moveY = blend.moveY;
    }

    // Smooth the output direction so waypoint transitions and kite reversals
    // produce a fluid arc rather than an instant direction snap. The blended
    // values are passed directly to playerInputSystem; normalizeInputDirection
    // keeps them unchanged when their length is ≤ 1, so the player naturally
    // accelerates/decelerates through turns at sub-full speed.
    if (travelEmergency) {
      // Imminent predicted contact / no safe lane: skip smoothing so the evasive
      // arc reaches playerInputSystem this frame instead of being averaged away.
      this.smoothMoveX = state.moveX;
      this.smoothMoveY = state.moveY;
    } else {
      this.smoothMoveX += (state.moveX - this.smoothMoveX) * MOVE_SMOOTH_FACTOR;
      this.smoothMoveY += (state.moveY - this.smoothMoveY) * MOVE_SMOOTH_FACTOR;
    }
    state.moveX = this.smoothMoveX;
    state.moveY = this.smoothMoveY;

    // Anti-stall for ENGAGE: when the blended direction drops below the stall
    // threshold (kite reversal or state-transition blend passing through zero)
    // while the enemy is still outside minimum contact range, bypass the
    // smooth stall and drive directly toward the enemy's world position.
    // Mirrors the enemyAISystem pathDirection.length ≤ EPSILON → direct
    // pursuit correction that fixed enemy "dancing" at tile-center distance.
    if (
      this.decision.state === AIState.ENGAGE &&
      this.decision.targetEid !== null &&
      Math.hypot(this.smoothMoveX, this.smoothMoveY) < ENGAGE_STALL_VELOCITY_THRESHOLD
    ) {
      const pursuit = this.enemyPursuitDirection(world, playerX, playerY, this.decision.targetEid);
      if (pursuit !== null) {
        const norm = normalizeInputDirection(pursuit.dx / pursuit.dist, pursuit.dy / pursuit.dist);
        state.moveX = norm.moveX;
        state.moveY = norm.moveY;
        this.smoothMoveX = norm.moveX;
        this.smoothMoveY = norm.moveY;
      }
    }

    state.action = false;

    if (this.decision.state === AIState.ENGAGE && this.decision.targetEid !== null) {
      const targetX = world.stores.position.x[this.decision.targetEid];
      const targetY = world.stores.position.y[this.decision.targetEid];
      if (typeof targetX === 'number' && typeof targetY === 'number') {
        state.pointerX = targetX;
        state.pointerY = targetY;
      } else if (this.decision.targetX !== null && this.decision.targetY !== null) {
        state.pointerX = this.decision.targetX;
        state.pointerY = this.decision.targetY;
      }
    } else {
      state.pointerX = playerX;
      state.pointerY = playerY;
    }
    setPreferredWeaponTarget(
      world,
      this.decision.state === AIState.ENGAGE ? this.decision.targetEid : null,
    );
  }

  private refreshQuestAcceptanceNavigation(world: GameWorld): void {
    const acceptedQuestCount = world.questLog.size;
    if (acceptedQuestCount === this.acceptedQuestCount) {
      return;
    }
    this.acceptedQuestCount = acceptedQuestCount;
    this.pathWaypoints = [];
    this.pathIndex = 0;
    this.pathGoalKey = null;
    this.resolvedGoalCache = null;
  }

  /**
   * Returns the normalised direction vector from the player to the given enemy
   * EID, or null if the enemy position is unavailable or already within
   * MIN_PLAYER_ENEMY_CONTACT_FT. Used by both the anti-stall override and the
   * ENGAGE fallback to avoid duplicating the position-validity + range check.
   */
  private enemyPursuitDirection(
    world: GameWorld,
    playerX: number,
    playerY: number,
    targetEid: number,
  ): { dx: number; dy: number; dist: number } | null {
    const ex = world.stores.position.x[targetEid];
    const ey = world.stores.position.y[targetEid];
    if (typeof ex !== 'number' || typeof ey !== 'number') return null;
    const dx = ex - playerX;
    const dy = ey - playerY;
    const dist = Math.hypot(dx, dy);
    if (dist <= MIN_PLAYER_ENEMY_CONTACT_FT) return null;
    return { dx, dy, dist };
  }

  /**
   * Rebuild the door-aware passability predicate and refresh locked-door memory.
   * Called once per poll so pathfinding reflects the current lock state.
   */
  private refreshDoorNavigation(world: GameWorld): void {
    this.doorAwarePassable = world.floorMap ? buildDoorAwarePassable(world) : null;
    // Record currently-blocked doors and forget any whose unlock condition is
    // now satisfied (C3 locked-door memory).
    const blockedDoors = getNavigationBlockedDoors(world);
    updateLockedDoorMemory(this.knownLockedDoors, blockedDoors);
    // Advance the navigation epoch whenever the passable graph could have changed
    // — a different floor, or a door flipping blocked<->passable. The static tile
    // topology is fixed for a floor's lifetime, so (floor, blocked-door tiles) is
    // a complete signature of what reachability depends on. This is what
    // invalidates the resolveReachableGoalTile memo.
    const signature =
      `${world.floor}:` +
      blockedDoors
        .map((door) => `${door.tileX},${door.tileY}`)
        .sort()
        .join('|');
    if (signature !== this.navSignature) {
      this.navSignature = signature;
      this.navEpoch += 1;
      // A door flip or floor change means passability changed — cached NPC
      // interaction anchors may now be stale (a newly-opened door could expose
      // a closer reachable tile). Invalidate so the next BFS runs fresh.
      this.npcInteractionAnchorCache.clear();
    }
  }

  /**
   * Shared A* options for ground movement, including the door-aware passability
   * override so routes can cross openable doors.
   */
  private groundPathOptions(): PathfindingOptions {
    return {
      traversalMode: PATH_TRAVERSAL.GROUND,
      maxPathLength: NAVIGATION_MAX_PATH_LENGTH,
      ...(this.doorAwarePassable ? { isTilePassable: this.doorAwarePassable } : {}),
    };
  }

  /**
   * Refresh the cached deterministic player→staircase-marker travel-time
   * estimate. Only meaningful while the staircase is unlocked but not yet
   * discovered — before unlock the AI still has quest work to do, so a stairs
   * beeline would starve XP/gold progression; after discovery the base BT
   * already commits to the stairs interact.
   *
   * The A* recompute is throttled to
   * {@link OBJECTIVE_TRAVEL_ASTAR_REFRESH_TICKS} frames (or one tile of player
   * movement) so the extra pathfinding cost stays bounded. Determinism is
   * preserved because `world.frameCount` is deterministic and the throttle
   * only affects _when_ we recompute, not the value returned.
   */
  private refreshPlayerToStairsTravelEstimate(
    world: GameWorld,
    playerX: number,
    playerY: number,
    playerSpeedFtPerFrame: number,
  ): void {
    const objective = world.floorScenario?.objective;
    const floorMap = world.floorMap;
    if (!objective || !floorMap) {
      this.lastPlayerToStairsTravelMs = null;
      return;
    }
    // Phase-gate: only run in the post-unlock, pre-discovery window.
    if (!objective.staircaseUnlocked || objective.staircaseDiscovered) {
      this.lastPlayerToStairsTravelMs = null;
      return;
    }

    const startTile = floorMap.worldToTile(playerX, playerY);
    const tileChanged =
      startTile.x !== this.lastPlayerToStairsTileX || startTile.y !== this.lastPlayerToStairsTileY;
    const frameDelta = world.frameCount - this.lastPlayerToStairsRefreshFrame;
    if (
      this.lastPlayerToStairsTravelMs !== null &&
      !tileChanged &&
      frameDelta < OBJECTIVE_TRAVEL_ASTAR_REFRESH_TICKS
    ) {
      return; // still fresh
    }

    const stairs = objective.staircasePos;
    const adapters: ObjectiveTravelAdapters = {
      worldToTile: (x, y) => floorMap.worldToTile(x, y),
      findTilePath: (start, goal) => findTilePath(floorMap, start, goal, this.groundPathOptions()),
      tileSizeFt: floorMap.config.tileSizeFt,
    };
    const estimate = estimateObjectiveTravelMs(
      { x: playerX, y: playerY },
      { x: stairs.x, y: stairs.y },
      adapters,
      {
        moveSpeedFtPerMs: playerSpeedFtPerFrame / GAME.DELTA_MS,
        wallSafetyFactor: OBJECTIVE_TRAVEL_WALL_SAFETY_FACTOR,
        wallSafetyBufferMs: OBJECTIVE_TRAVEL_WALL_SAFETY_BUFFER_MS,
      },
    );
    this.lastPlayerToStairsTravelMs = estimate.travelMs;
    this.lastPlayerToStairsRefreshFrame = world.frameCount;
    this.lastPlayerToStairsTileX = startTile.x;
    this.lastPlayerToStairsTileY = startTile.y;
  }

  private getCollapsePanicProfile(world: GameWorld): CollapsePanicProfile {
    const objective = world.floorScenario?.objective;
    if (!objective) {
      return computeCollapsePanicProfile(null);
    }
    return computeCollapsePanicProfile({
      elapsedMs: world.elapsedMs,
      deadlineMs: resolveFloor1AiCollapsePanicDeadlineMs(objective.deadlineMs),
      staircaseUnlocked: objective.staircaseUnlocked,
      staircaseDiscovered: objective.staircaseDiscovered,
      playerToStairsTravelMs: this.lastPlayerToStairsTravelMs,
    });
  }

  private getDynamicOpportunisticWeights(world: GameWorld): {
    dodgeWeight: number;
    collectPullWeight: number;
    farmPullWeight: number;
  } {
    const profile = this.getCollapsePanicProfile(world);
    const collectScale = profile.beeline ? 0 : Math.max(0, 1 - profile.panic * 1.1);
    const farmScale = profile.beeline ? 0 : Math.max(0, 1 - profile.panic * 1.35);
    const dodgeFloor = profile.stairsUnlocked
      ? PANIC_MIN_DODGE_WEIGHT_SCALE
      : PANIC_MIN_DODGE_WEIGHT_SCALE_LOCKED;
    const dodgeScale = Math.max(dodgeFloor, 1 - profile.panic * 0.9);
    return {
      dodgeWeight: this.config.dodgeWeight * dodgeScale,
      collectPullWeight: this.config.collectPullWeight * collectScale,
      farmPullWeight: this.config.farmPullWeight * farmScale,
    };
  }

  /**
   * Additively blend the Track B opportunistic vectors (dodge, loot-collect pull,
   * enemy-farm pull) into a base heading and renormalise to unit length if the
   * combined magnitude exceeds 1. Pure arithmetic — extracted verbatim from the
   * legacy inline poll() blend so LEGACY pathing stays byte-identical, and reused
   * by {@link computeRiskRewardFusedHeading} to fold reward pull into the fused
   * desired direction.
   */
  private blendWithTrackB(
    baseMoveX: number,
    baseMoveY: number,
    weights: { dodgeWeight: number; collectPullWeight: number; farmPullWeight: number },
  ): { moveX: number; moveY: number } {
    const blendX =
      baseMoveX +
      this.dodgeVecX * weights.dodgeWeight +
      this.opportunisticPullX * weights.collectPullWeight +
      this.farmPullX * weights.farmPullWeight;
    const blendY =
      baseMoveY +
      this.dodgeVecY * weights.dodgeWeight +
      this.opportunisticPullY * weights.collectPullWeight +
      this.farmPullY * weights.farmPullWeight;
    const blendLen = Math.hypot(blendX, blendY);
    if (blendLen <= 1) {
      return { moveX: blendX, moveY: blendY };
    }
    return { moveX: blendX / blendLen, moveY: blendY / blendLen };
  }

  /**
   * RISK_REWARD_FUSED heading scorer (AIPathingMode.RISK_REWARD_FUSED). Fans a set
   * of candidate headings around the desired (Track A + Track B) direction and
   * picks the one that best trades objective progress and reward pull against
   * sampled overlap-danger (enemy proximity at a projected lookahead point,
   * amplified near walls, plus fog/door penalties) with a small continuity bonus
   * to damp oscillation. Returns a unit heading (or {0,0} when idle). Dormant
   * unless pathingMode === RISK_REWARD_FUSED.
   */
  private computeRiskRewardFusedHeading(
    world: GameWorld,
    playerX: number,
    playerY: number,
    baseMoveX: number,
    baseMoveY: number,
    weights: { dodgeWeight: number; collectPullWeight: number; farmPullWeight: number },
  ): { moveX: number; moveY: number } {
    const baseLen = Math.hypot(baseMoveX, baseMoveY);
    if (baseLen <= TRAVEL_HEADING_EPSILON) {
      // Continuity is only valid across CONSECUTIVE travel polls. A no-heading poll
      // (stopped, target lost, or between goals) breaks that chain, so clear it —
      // otherwise the next travel poll would be biased toward a stale heading,
      // creating hysteresis the win/loss gate cannot see (plan review 2026-07-08).
      this.prevFusedDirX = 0;
      this.prevFusedDirY = 0;
      if (this.fusedDebugCapture) this.fusedDebug = null;
      return { moveX: 0, moveY: 0 };
    }

    const blended = this.blendWithTrackB(baseMoveX, baseMoveY, weights);
    const blendedLen = Math.hypot(blended.moveX, blended.moveY);
    if (blendedLen <= TRAVEL_HEADING_EPSILON) {
      // Track A + Track B cancelled to ~zero: fall back to the raw objective
      // heading, but the danger-scored fan did NOT run this poll, so break the
      // continuity chain the same way the baseLen early-return above does.
      // Leaving prevFusedDir stale would bias the next full poll toward a heading
      // from an older, non-consecutive fan (code review 2026-07-08, non-blocking).
      this.prevFusedDirX = 0;
      this.prevFusedDirY = 0;
      if (this.fusedDebugCapture) this.fusedDebug = null;
      return { moveX: baseMoveX / baseLen, moveY: baseMoveY / baseLen };
    }

    const objectiveX = baseMoveX / baseLen;
    const objectiveY = baseMoveY / baseLen;
    const rewardX =
      this.opportunisticPullX * weights.collectPullWeight + this.farmPullX * weights.farmPullWeight;
    const rewardY =
      this.opportunisticPullY * weights.collectPullWeight + this.farmPullY * weights.farmPullWeight;
    const rewardLen = Math.hypot(rewardX, rewardY);
    const rewardDirX = rewardLen > TRAVEL_HEADING_EPSILON ? rewardX / rewardLen : 0;
    const rewardDirY = rewardLen > TRAVEL_HEADING_EPSILON ? rewardY / rewardLen : 0;

    const threatPoints: { x: number; y: number; radiusFt: number }[] = [];
    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      if (eid === undefined) continue;
      if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      if (!this.canPerceiveWorldPosition(world, ex, ey)) continue;
      // Enemies always move toward the player (flow-map driven) so projected
      // position is always at least as dangerous as current. Use it directly.
      const vx = world.stores.velocity.x[eid] ?? 0;
      const vy = world.stores.velocity.y[eid] ?? 0;
      // A ranged enemy's danger bubble must reach as far as it can actually
      // hit, not just the generic near-body radius — otherwise the fused
      // heading scorer would only "see" ranged threats once the player is
      // already melee-close to them.
      const attackRangeFt = world.stores.enemyBehavior.attackRange[eid] ?? 0;
      const radiusFt = Math.max(RISK_REWARD_DANGER_RADIUS_FT, attackRangeFt);
      threatPoints.push({
        x: ex + vx * RISK_REWARD_VELOCITY_LOOKAHEAD_FRAMES,
        y: ey + vy * RISK_REWARD_VELOCITY_LOOKAHEAD_FRAMES,
        radiusFt,
      });
    }

    const desiredX = blended.moveX / blendedLen;
    const desiredY = blended.moveY / blendedLen;
    let bestX = desiredX;
    let bestY = desiredY;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestIndex = 0;
    let candidateIndex = 0;
    const captured: FusedCandidateDebug[] | null = this.fusedDebugCapture ? [] : null;
    for (const deg of RISK_REWARD_CANDIDATE_OFFSETS_DEG) {
      const rad = (deg * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      const dirX = desiredX * c - desiredY * s;
      const dirY = desiredX * s + desiredY * c;

      const sampleX = playerX + dirX * RISK_REWARD_DANGER_LOOKAHEAD_FT;
      const sampleY = playerY + dirY * RISK_REWARD_DANGER_LOOKAHEAD_FT;
      const floorMap = world.floorMap;
      let danger = 0;
      let wallAdjacent = false;

      if (floorMap) {
        // Multi-step raycast: detect if any step along the candidate ray enters a
        // wall. Marks wall-adjacent but does NOT set danger directly — walls alone
        // produce zero danger; only wall + enemy = amplified danger.
        const steps = [0.25, 0.5, 0.75, 1.0] as const;
        for (const t of steps) {
          if (
            !floorMap.isPassableAt(sampleX * t + playerX * (1 - t), sampleY * t + playerY * (1 - t))
          ) {
            wallAdjacent = true;
            break;
          }
        }

        // Enemy threat accumulation against projected positions. Each threat
        // uses its OWN radius (Math.max(base, actual ranged attackRange) —
        // see threatPoints construction above), so a long-range shooter's
        // danger bubble extends to its real reach.
        for (const threat of threatPoints) {
          const dist = Math.hypot(threat.x - sampleX, threat.y - sampleY);
          if (dist >= threat.radiusFt) continue;
          const norm = 1 - dist / threat.radiusFt;
          danger += norm * norm;
        }

        // Perpendicular wall-proximity: if either corridor wall is within
        // RISK_REWARD_WALL_PROXIMITY_FT at the midpoint, mark wall-adjacent.
        if (!wallAdjacent) {
          const midX = playerX + dirX * RISK_REWARD_DANGER_LOOKAHEAD_FT * 0.5;
          const midY = playerY + dirY * RISK_REWARD_DANGER_LOOKAHEAD_FT * 0.5;
          const perpX = -dirY;
          const perpY = dirX;
          if (
            !floorMap.isPassableAt(
              midX + perpX * RISK_REWARD_WALL_PROXIMITY_FT,
              midY + perpY * RISK_REWARD_WALL_PROXIMITY_FT,
            ) ||
            !floorMap.isPassableAt(
              midX - perpX * RISK_REWARD_WALL_PROXIMITY_FT,
              midY - perpY * RISK_REWARD_WALL_PROXIMITY_FT,
            )
          ) {
            wallAdjacent = true;
          }
        }

        // Apply wall amplifier: being trapped against a wall with an enemy is
        // more dangerous than the same enemy in open space. Empty corridors are fine.
        if (wallAdjacent && danger > 0) {
          danger *= RISK_REWARD_WALL_AMPLIFICATION;
        }

        // Unseen-area penalty: heading into fog-of-war is risky.
        if (!floorMap.isVisibleAt(sampleX, sampleY)) {
          danger += RISK_REWARD_FOG_DANGER;
        }

        // Door-crossing penalty.
        const midX = playerX + dirX * RISK_REWARD_DANGER_LOOKAHEAD_FT * 0.5;
        const midY = playerY + dirY * RISK_REWARD_DANGER_LOOKAHEAD_FT * 0.5;
        const midTile = floorMap.worldToTile(midX, midY);
        if (
          floorMap.tileMap.isDoor(midTile.x, midTile.y) &&
          !floorMap.isVisibleAt(sampleX, sampleY)
        ) {
          danger += RISK_REWARD_DOOR_DANGER;
        }
      } else {
        // No floor map: enemy-only danger.
        for (const threat of threatPoints) {
          const dist = Math.hypot(threat.x - sampleX, threat.y - sampleY);
          if (dist >= threat.radiusFt) continue;
          const norm = 1 - dist / threat.radiusFt;
          danger += norm * norm;
        }
      }

      const progress = Math.max(0, dirX * objectiveX + dirY * objectiveY);
      const reward =
        rewardLen > TRAVEL_HEADING_EPSILON ? Math.max(0, dirX * rewardDirX + dirY * rewardDirY) : 0;
      // `reward * rewardLen` carries raw pull magnitude; pull vectors are always
      // unit-normalised (rewardLen ≤ ~0.57) so the term stays [0, 1]-bounded and
      // comparable to progress/danger. Distance-weighted pull sources would break
      // this invariant and should re-normalise before passing in.
      const continuity =
        this.prevFusedDirX !== 0 || this.prevFusedDirY !== 0
          ? dirX * this.prevFusedDirX + dirY * this.prevFusedDirY
          : 0;
      const score =
        progress * RISK_REWARD_W_PROGRESS +
        reward * rewardLen * RISK_REWARD_W_REWARD -
        danger * RISK_REWARD_W_DANGER +
        continuity * RISK_REWARD_W_CONTINUITY;
      if (score > bestScore) {
        bestScore = score;
        bestX = dirX;
        bestY = dirY;
        bestIndex = candidateIndex;
      }
      if (captured) {
        // Record the pre-weight component terms so the visualizer can show WHY a
        // candidate scored (progress/reward/danger/continuity) alongside the final
        // weighted score. `reward * rewardLen` is the reward term as it enters the
        // score (pre-W_REWARD); danger/continuity/progress are raw (pre-weight).
        captured.push({
          angleDeg: deg,
          dirX,
          dirY,
          progress,
          reward: reward * rewardLen,
          danger,
          continuity,
          score,
          chosen: false,
        });
      }
      candidateIndex++;
    }

    this.prevFusedDirX = bestX;
    this.prevFusedDirY = bestY;
    if (captured) {
      const chosen = captured[bestIndex];
      if (chosen) chosen.chosen = true;
      this.fusedDebug = {
        playerX,
        playerY,
        desiredX,
        desiredY,
        bestX,
        bestY,
        bestScore,
        lookaheadFt: RISK_REWARD_DANGER_LOOKAHEAD_FT,
        dangerRadiusFt: RISK_REWARD_DANGER_RADIUS_FT,
        threats: threatPoints.map((t) => ({ x: t.x, y: t.y, radiusFt: t.radiusFt })),
        candidates: captured,
      };
    }
    return { moveX: bestX, moveY: bestY };
  }

  /**
   * Debug-only: the last {@link FusedHeadingDebug} snapshot captured by the
   * RISK_REWARD_FUSED scorer, or `null` when capture is off, the AI is idle, or
   * pathing is LEGACY. Enable capture via {@link fusedDebugCapture}.
   */
  getFusedDebug(): FusedHeadingDebug | null {
    return this.fusedDebug;
  }

  private getPlayerSpeedFtPerFrame(world: GameWorld, playerEid: number): number {
    return computeMoveSpeed(world, playerEid, PLAYER_SPEED);
  }

  private getRunPlannerParams(playerSpeedFtPerFrame: number): RunPlannerParams {
    return {
      ...RUN_PLANNER_PARAMS,
      moveSpeedFtPerMs: playerSpeedFtPerFrame / GAME.DELTA_MS,
    };
  }

  private getCurrentRunPlannerTargetKind(
    world: GameWorld,
    shopStage: ReturnType<typeof getShopkeeperStage>,
  ): RunPlannerCurrentTargetKind {
    const targetEid = this.decision.targetEid;
    const objective = world.floorScenario?.objective;
    if (!objective || targetEid === null || targetEid < 0) {
      return 'other';
    }
    if (!objective.questCompleted && world.floorScenario?.enemyArchetypes.has(targetEid)) {
      return 'quest-kills';
    }
    if (shopStage === 'ready-to-buy' && world.playerGold < SHOPKEEPER_EQUIPMENT_COST) {
      if (hasComponent(world.ecs, targetEid, Gold) || hasComponent(world.ecs, targetEid, Enemy)) {
        return 'gold-farm';
      }
    }
    return 'other';
  }

  private estimateCurrentRunPlan(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
    playerSpeedFtPerFrame: number,
  ): Floor1RunPlan | null {
    const floorScenario = world.floorScenario;
    const objective = floorScenario?.objective;
    if (!floorScenario || !objective) {
      return null;
    }

    const hasWorldFetchItem =
      floorScenario.questItemEid !== null &&
      entityExists(world.ecs, floorScenario.questItemEid) &&
      hasComponent(world.ecs, floorScenario.questItemEid, DroppedItem);
    const bag = world.inventories.get(playerEid);
    const hasFetchItem = bag ? hasItem(bag, SHOPKEEPER_FETCH_ITEM_ID) : false;
    const slimeRat = objective.bossBattles.get('slime-rat')!;
    const staircase = objective.bossBattles.get('staircase')!;
    const shopStage = getShopkeeperStage(world);
    const merchantWeaponIntent = getMerchantWeaponIntent(world);
    const committedDetourEid = this.committedDetourNpcEid;
    const committedDetourX =
      committedDetourEid === null ? undefined : world.stores.position.x[committedDetourEid];
    const committedDetourY =
      committedDetourEid === null ? undefined : world.stores.position.y[committedDetourEid];
    const committedDetourAction =
      committedDetourEid === null
        ? null
        : this.getNpcInteractionReason(world, playerEid, committedDetourEid);
    const committedDetourAnchor =
      committedDetourEid !== null &&
      committedDetourX !== undefined &&
      committedDetourY !== undefined
        ? this.resolveNpcInteractionAnchor(
            world,
            playerX,
            playerY,
            committedDetourX,
            committedDetourY,
            committedDetourEid,
          )
        : null;
    const currentTarget =
      committedDetourEid !== null && committedDetourAnchor
        ? {
            ...committedDetourAnchor,
            eid: committedDetourEid,
            reason: `Committed quest-giver detour`,
            kind: 'other' as const,
            committedGoalId: floor1GoalIdForNpcInteraction(committedDetourAction),
          }
        : this.decision.targetX !== null && this.decision.targetY !== null
          ? {
              x: this.decision.targetX,
              y: this.decision.targetY,
              eid: this.decision.targetEid,
              reason: this.decision.reason,
              kind: this.getCurrentRunPlannerTargetKind(world, shopStage),
            }
          : null;
    const snapshot: Floor1RunPlannerSnapshot = {
      nowMs: world.elapsedMs,
      deadlineMs: objective.deadlineMs,
      player: { x: playerX, y: playerY },
      currentTarget,
      activeQuestGiverDetour: committedDetourEid !== null && committedDetourAnchor !== null,
      tutorialAccepted: world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID),
      playerLevel: world.playerLevel.level,
      questCompleted: objective.questCompleted,
      ratsKilled: objective.ratsKilled,
      slimesKilled: objective.slimesKilled,
      requiredRats: objective.requiredRats,
      requiredSlimes: objective.requiredSlimes,
      requiredTotalKills: floor1Config.objectives.requiredTotalKills,
      shopStage,
      playerGold: world.playerGold,
      shopkeeperEquipmentCost: SHOPKEEPER_EQUIPMENT_COST,
      hasShopFetchItem: hasFetchItem || !hasWorldFetchItem,
      bossBattleAccepted: world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID),
      slimeRatStarted: slimeRat.started,
      slimeRatDefeated: slimeRat.defeated,
      spellsUnlocked: world.featureUnlocks.spells,
      bossBattleComplete: world.goalFlags.get('floor1-boss-battle-complete') === true,
      staircaseStarted: staircase.started,
      staircaseDefeated: staircase.defeated,
      staircaseUnlocked: objective.staircaseUnlocked,
      staircaseDiscovered: objective.staircaseDiscovered,
      merchantWeaponIntent:
        merchantWeaponIntent.enabled &&
        (merchantWeaponIntent.status === 'farming' || merchantWeaponIntent.status === 'returning')
          ? { status: merchantWeaponIntent.status, cost: merchantWeaponIntent.cost }
          : null,
      positions: {
        welcomeOffice: objective.welcomeOfficePos,
        shop: objective.shopRoomPos,
        questItem: objective.questItemPos,
        spellQuestGiver: objective.spellQuestGiverPos,
        slimeRatRoom: objective.slimeRatRoomPos,
        staircase: objective.staircasePos,
      },
    };
    const params = this.getRunPlannerParams(playerSpeedFtPerFrame);
    const cacheKey = buildRunPlanCacheKey(snapshot, params);
    let route = this.runPlanCache;
    if (cacheKey !== this.runPlanCacheKey || route === null) {
      route = planFloor1ObjectiveRoute(snapshot, params);
      this.runPlanCacheKey = cacheKey;
      this.runPlanCache = route;
    }
    return estimateFloor1RunPlan(snapshot, params, route);
  }

  private getMerchantDecisionRunPlan(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
    playerSpeedFtPerFrame: number,
  ): Floor1RunPlan | null {
    if (
      this.merchantDecisionRunPlan === null ||
      world.frameCount - this.merchantDecisionRunPlanFrame >=
        MERCHANT_DECISION_RUN_PLAN_CACHE_FRAMES
    ) {
      this.merchantDecisionRunPlan = this.estimateCurrentRunPlan(
        world,
        playerEid,
        playerX,
        playerY,
        playerSpeedFtPerFrame,
      );
      this.merchantDecisionRunPlanFrame = world.frameCount;
    }
    return this.merchantDecisionRunPlan;
  }

  private getLootOpportunityValue(world: GameWorld, eid: number, kind: TacticalPickupKind): number {
    switch (kind) {
      case 'xp':
        return Math.max(1, world.stores.xpGem.value[eid] ?? 1);
      case 'gold':
        return TACTICAL_OPPORTUNITY_GOLD_VALUE;
      case 'item':
        return TACTICAL_OPPORTUNITY_ITEM_VALUE;
    }
  }

  private collectTacticalOpportunityEnemySnapshots(
    world: GameWorld,
    playerX: number,
    playerY: number,
    radiusFt: number = TRAVEL_THREAT_RADIUS_FT,
  ): TacticalOpportunityEnemySnapshot[] {
    const maxPlayerDistance = TACTICAL_OPPORTUNITY_SCAN_RADIUS_FT + radiusFt;
    const maxPlayerDistanceSq = maxPlayerDistance * maxPlayerDistance;
    const enemies: TacticalOpportunityEnemySnapshot[] = [];
    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      if (eid === undefined) continue;
      const hp = world.stores.health.current[eid] ?? 0;
      if (hp <= 0) continue;
      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      const dx = x - playerX;
      const dy = y - playerY;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > maxPlayerDistanceSq) continue;
      enemies.push({ eid, hp, x, y, distance: Math.sqrt(distanceSq) });
    }
    return enemies;
  }

  private estimateOpportunityDanger(
    enemies: readonly TacticalOpportunityEnemySnapshot[],
    x: number,
    y: number,
    radiusFt: number = TRAVEL_THREAT_RADIUS_FT,
  ): number {
    let danger = 0;
    for (const enemy of enemies) {
      const dist = Math.hypot(enemy.x - x, enemy.y - y);
      if (dist > radiusFt) continue;
      danger += 1 - dist / radiusFt;
    }
    return danger;
  }

  private buildTacticalOpportunityCandidates(
    world: GameWorld,
    playerX: number,
    playerY: number,
  ): TacticalOpportunityCandidate[] {
    const candidates: TacticalOpportunityCandidate[] = [];
    const enemies = this.collectTacticalOpportunityEnemySnapshots(world, playerX, playerY);
    const lootSources: Array<{ kind: TacticalPickupKind; entities: ReturnType<typeof query> }> = [
      { kind: 'xp', entities: query(world.ecs, [XpGem, Position]) },
      { kind: 'gold', entities: query(world.ecs, [Gold, Position]) },
      { kind: 'item', entities: query(world.ecs, [DroppedItem, Position]) },
    ];

    for (const source of lootSources) {
      for (const eid of source.entities) {
        if (eid === undefined) continue;
        const ignoredUntil = this.ignoredLootUntilFrame.get(eid);
        if (ignoredUntil !== undefined && ignoredUntil > world.frameCount) continue;
        if (ignoredUntil !== undefined && ignoredUntil <= world.frameCount) {
          this.ignoredLootUntilFrame.delete(eid);
        }
        const x = world.stores.position.x[eid] ?? 0;
        const y = world.stores.position.y[eid] ?? 0;
        const distance = Math.hypot(x - playerX, y - playerY);
        if (distance > TACTICAL_OPPORTUNITY_SCAN_RADIUS_FT) continue;
        const loot: LootTarget = { eid, x, y, distance, kind: source.kind };
        candidates.push({
          id: eid,
          kind: 'pickup',
          pickupKind: source.kind,
          x,
          y,
          value: this.getLootOpportunityValue(world, eid, source.kind),
          danger: this.estimateOpportunityDanger(enemies, x, y),
          reachable: this.isLootCollectable(world, playerX, playerY, loot),
        });
      }
    }

    if (this.config.debug) {
      for (const enemy of enemies) {
        if (enemy.distance > TACTICAL_OPPORTUNITY_SCAN_RADIUS_FT) continue;
        const target: WorldTarget = {
          eid: enemy.eid,
          x: enemy.x,
          y: enemy.y,
          distance: enemy.distance,
        };
        candidates.push({
          id: enemy.eid,
          kind: 'enemyPack',
          x: enemy.x,
          y: enemy.y,
          value: Math.max(
            TACTICAL_OPPORTUNITY_ENEMY_PACK_MIN_VALUE,
            TACTICAL_OPPORTUNITY_ENEMY_PACK_BASE_VALUE -
              enemy.hp * TACTICAL_OPPORTUNITY_ENEMY_PACK_HP_PENALTY,
          ),
          danger: this.estimateOpportunityDanger(enemies, enemy.x, enemy.y),
          reachable: this.isTargetReachable(world, playerX, playerY, target),
          debugOnly: true,
        });
      }
    }

    return candidates;
  }

  private evaluateTacticalObjectiveOpportunities(
    world: GameWorld,
    playerX: number,
    playerY: number,
    objectiveX: number,
    objectiveY: number,
    runPlan: Floor1RunPlan | null,
    playerSpeedFtPerFrame: number,
  ): TacticalOpportunityEvaluation {
    const inQuestGiverDetour = this.committedDetourNpcEid !== null;
    const params: TacticalOpportunityParams = inQuestGiverDetour
      ? {
          ...TACTICAL_OPPORTUNITY_PARAMS,
          maxDetourFt: TACTICAL_OPPORTUNITY_TRIVIAL_DETOUR_FT,
          maxAccepted: 1,
        }
      : TACTICAL_OPPORTUNITY_PARAMS;
    return evaluateTacticalOpportunities(
      {
        playerX,
        playerY,
        objectiveX,
        objectiveY,
        urgency: runPlan?.urgency ?? this.getCollapsePanicProfile(world).panic,
        speedFtPerMs: playerSpeedFtPerFrame / GAME.DELTA_MS,
        opportunities: this.buildTacticalOpportunityCandidates(world, playerX, playerY),
      },
      params,
    );
  }

  private withQuestGiverDetour(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
    target: ProgressTarget,
    panicProfile: CollapsePanicProfile,
  ): ProgressTarget {
    // A. Hard early exits (release any stale commitment first).
    if (panicProfile.beeline) {
      // Late-floor emergency beeline: never sit on a detour.
      this.releaseDetourCommitment();
      return target;
    }
    if (target.eid >= 0 && world.npcs.has(target.eid)) {
      // The main objective is itself an NPC; don't stack a detour on top.
      this.releaseDetourCommitment();
      return target;
    }
    if (world.playerInSafeRoom && target.eid >= 0 && this.committedDetourNpcEid === null) {
      // Shared-room hubs make same-safe-room NPCs visible while the player is
      // retreating through the welcome room from a dynamic objective (enemy/loot).
      // Do not start a fresh pinball detour in that state; once the dynamic
      // objective is resumed outside the safe room, the normal detour rules can
      // evaluate again. Existing detour commitments still fall through to the
      // hysteresis/no-progress path below so safe-room mouth flicker stays stable.
      return target;
    }
    if (world.frameCount < this.progressGoalSuppressedUntilFrame) {
      // Stall-recovery is suppressing wedged progress goals. Yield entirely — drop
      // any held commitment AND make no fresh one — so the BT falls through to
      // Hunt/Engage relocation instead of re-parking on a quest NPC. Hoisted above
      // Blocks B–D so it closes every commit path (a Block-C-only check let Block B
      // and Block D immediately re-commit and defeat the watchdog).
      this.releaseDetourCommitment();
      return target;
    }

    const nearestNpc = this.findNearestRelevantNpc(world, playerEid, playerX, playerY);
    const nearestRelevant =
      nearestNpc &&
      typeof nearestNpc.interactionReason === 'string' &&
      nearestNpc.interactionReason.length > 0 &&
      nearestNpc.eid !== target.eid
        ? nearestNpc
        : null;

    // B. A fresh same-safe-room relevant NPC is a stable, high-priority pick that
    //    PREEMPTS any stale outside-room commitment. Same-room is a steady state
    //    (both bodies inside the safe room), not the mouth-boundary flicker, so it
    //    cannot reintroduce per-frame thrash. Only a DIFFERENT NPC preempts here:
    //    if it is already the committed NPC, fall through to Block C so the
    //    no-progress valve / relaxed cap keep ticking (Block B is a same-eid no-op,
    //    so a same-room commit routed through here would never self-release).
    if (
      nearestRelevant &&
      nearestRelevant.eid !== this.committedDetourNpcEid &&
      world.playerInSafeRoom &&
      isPointInSafeSpace(world, nearestRelevant.x, nearestRelevant.y) &&
      this.isPlayerAndNpcInSameSafeRoom(
        world,
        playerX,
        playerY,
        nearestRelevant.x,
        nearestRelevant.y,
      )
    ) {
      return this.commitDetourTo(world, nearestRelevant, playerX, playerY);
    }

    // C. Honor an existing commitment, re-derived live (bypassing the
    //    findNearestRelevantNpc safe-room filter) so it survives the
    //    playerInSafeRoom mouth-boundary flicker. This is the core fix.
    const committed = this.getCommittedQuestGiverDetour(world, playerEid, playerX, playerY, target);
    if (committed) {
      return this.detourTargetFor(world, committed, playerX, playerY);
    }

    // D. No commitment → fresh candidate selection with the STRICT base cap.
    if (!nearestRelevant) {
      return target;
    }
    // Arrival guard: within interaction range the Interact node owns the NPC
    // (nearestRelevant came from findNearestRelevantNpc, so it is eligible now).
    if (this.withinInteractionRange(nearestRelevant.distance)) {
      return target;
    }

    const viaNpcDistance =
      nearestRelevant.distance +
      Math.hypot(target.x - nearestRelevant.x, target.y - nearestRelevant.y);
    const detourExtra = viaNpcDistance - target.distance;
    const detourCap = Math.max(
      QUEST_GIVER_DETOUR_MAX_EXTRA_FT,
      target.distance * QUEST_GIVER_DETOUR_MAX_EXTRA_FRACTION,
    );
    if (detourExtra > detourCap) {
      return target;
    }

    return this.commitDetourTo(world, nearestRelevant, playerX, playerY);
  }

  /** Interaction-range predicate, matching the `Interact` BT node exactly (strict
   * `<`) so a committed detour hands off to Interact on the same frame it would
   * fire, with no 1-frame "drop the NPC" gap. */
  private withinInteractionRange(distance: number): boolean {
    return distance < NPC_INTERACTION_RADIUS_FT;
  }

  /** Whether an NPC at (npcX, npcY) is eligible for interaction this frame — i.e.
   * not filtered by the same `playerInSafeRoom && !isPointInSafeSpace` guard that
   * {@link findNearestRelevantNpc} and the Interact node apply. */
  private isNpcInteractEligible(world: GameWorld, npcX: number, npcY: number): boolean {
    return !(world.playerInSafeRoom && !isPointInSafeSpace(world, npcX, npcY));
  }

  /** True when the player and the NPC occupy the same SAFE room. */
  private isPlayerAndNpcInSameSafeRoom(
    world: GameWorld,
    playerX: number,
    playerY: number,
    npcX: number,
    npcY: number,
  ): boolean {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return false;
    }
    const playerTile = floorMap.worldToTile(playerX, playerY);
    const npcTile = floorMap.worldToTile(npcX, npcY);
    const safeRooms = floorMap.roomGraph.getRoomsByRole(RoomRole.SAFE);
    for (const {
      bounds: { x: rx, y: ry, width, height },
    } of safeRooms) {
      const playerInRoom =
        playerTile.x >= rx &&
        playerTile.x < rx + width &&
        playerTile.y >= ry &&
        playerTile.y < ry + height;
      const npcInRoom =
        npcTile.x >= rx && npcTile.x < rx + width && npcTile.y >= ry && npcTile.y < ry + height;
      if (playerInRoom && npcInRoom) {
        return true;
      }
    }
    return false;
  }

  /** Build a "Detouring to …" progress target pointing at the given NPC. */
  private detourTargetFor(
    world: GameWorld,
    npc: NpcTarget,
    playerX: number,
    playerY: number,
  ): ProgressTarget {
    const readableReason = npc.interactionReason.replaceAll('-', ' ');
    return this.createNpcProgressTarget(
      world,
      playerX,
      playerY,
      npc.eid,
      `Detouring to ${npc.defId} (${readableReason})`,
      npc.x,
      npc.y,
      npc.interactionReason,
    );
  }

  /** Latch a detour commitment on the given NPC (resetting the no-progress valve
   * when the committed entity changes) and return the detour target. */
  private commitDetourTo(
    world: GameWorld,
    npc: NpcTarget,
    playerX: number,
    playerY: number,
  ): ProgressTarget {
    if (this.committedDetourNpcEid !== npc.eid) {
      this.committedDetourNpcEid = npc.eid;
      this.committedDetourBestDistance = npc.distance;
      this.committedDetourNoProgressFrames = 0;
      this.merchantDecisionRunPlan = null;
      this.merchantDecisionRunPlanFrame = -Infinity;
    }
    return this.detourTargetFor(world, npc, playerX, playerY);
  }

  /** Clear any active detour commitment and its no-progress bookkeeping. */
  private releaseDetourCommitment(): void {
    const hadCommitment = this.committedDetourNpcEid !== null;
    this.committedDetourNpcEid = null;
    this.committedDetourBestDistance = Number.POSITIVE_INFINITY;
    this.committedDetourNoProgressFrames = 0;
    if (hadCommitment) {
      this.merchantDecisionRunPlan = null;
      this.merchantDecisionRunPlanFrame = -Infinity;
    }
  }

  /**
   * Re-derive the currently-committed quest-giver detour NPC directly from world
   * state — deliberately NOT via {@link findNearestRelevantNpc}, whose
   * `playerInSafeRoom` filter is exactly what flip-flops at the safe-room mouth.
   * Returns the live NPC target while the commitment is still valid, or null (and
   * clears the commitment) on any release condition.
   */
  private getCommittedQuestGiverDetour(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
    target: ProgressTarget,
  ): NpcTarget | null {
    const eid = this.committedDetourNpcEid;
    if (eid === null) {
      return null;
    }
    // NOTE: progress-goal suppression is handled up-front in withQuestGiverDetour
    // (Block A), which releases the commitment and returns before this helper runs,
    // so no suppression check is needed (or reachable) here.
    const instance = world.npcs.get(eid);
    if (!instance) {
      this.releaseDetourCommitment();
      return null;
    }
    const x = world.stores.position.x[eid];
    const y = world.stores.position.y[eid];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      this.releaseDetourCommitment();
      return null;
    }
    const interactionReason = this.getNpcInteractionReason(world, playerEid, eid);
    if (typeof interactionReason !== 'string' || interactionReason.length === 0) {
      // NPC handled — nothing left to interact with.
      this.releaseDetourCommitment();
      return null;
    }
    const distance = Math.hypot(x - playerX, y - playerY);
    // Arrival: within range AND actually eligible this frame → let Interact own it.
    // If in range but still filtered (in-safe, NPC outside), KEEP steering so the
    // player crosses out and Interact becomes eligible, rather than dropping it.
    if (this.withinInteractionRange(distance) && this.isNpcInteractEligible(world, x, y)) {
      this.releaseDetourCommitment();
      return null;
    }
    // No-progress abandon valve: release an unreachable / body-blocked / locked-out
    // committed NPC well under the floor-collapse deadline.
    if (distance < this.committedDetourBestDistance - ENGAGE_PROGRESS_EPSILON_FT) {
      this.committedDetourBestDistance = distance;
      this.committedDetourNoProgressFrames = 0;
    } else {
      this.committedDetourNoProgressFrames += 1;
      if (this.committedDetourNoProgressFrames > QUEST_GIVER_DETOUR_ABANDON_FRAMES) {
        this.releaseDetourCommitment();
        return null;
      }
    }
    // Relaxed cap: only the already-committed path tolerates the widened detour.
    const viaNpcDistance = distance + Math.hypot(target.x - x, target.y - y);
    const detourExtra = viaNpcDistance - target.distance;
    const detourCap = Math.max(
      QUEST_GIVER_DETOUR_MAX_EXTRA_FT,
      target.distance * QUEST_GIVER_DETOUR_MAX_EXTRA_FRACTION,
    );
    if (detourExtra > detourCap * QUEST_GIVER_DETOUR_COMMIT_HYSTERESIS) {
      this.releaseDetourCommitment();
      return null;
    }
    return {
      eid,
      x,
      y,
      distance,
      defId: instance.defId,
      interactionReason,
    };
  }

  private moveToward(
    state: InputState,
    world: GameWorld,
    playerX: number,
    playerY: number,
    targetX: number,
    targetY: number,
  ): void {
    const deltaX = targetX - playerX;
    const deltaY = targetY - playerY;
    const distance = Math.hypot(deltaX, deltaY);

    if (distance < DIRECT_MOVE_EPSILON_FT) {
      // Close enough - stop moving
      state.moveX = 0;
      state.moveY = 0;
      return;
    }

    // Close-range direct approach. Tile-granular A* targets tile centers and
    // cannot step the 24px player body onto a small (8px) pickup; worse,
    // resolveReachableGoalTile diverts to an ADJACENT tile whenever the target
    // sits in the player's own tile (same-tile A* is trivial), so the player
    // oscillates walk-away/walk-back around a gem/gold it never overlaps (the
    // "wiggling on pickups" bug). When the target is within ~1.5 tiles and a
    // straight corridor is clear, skip A* and slide straight at the exact world point
    // with obstacle-aware local navigation so the body physically overlaps the
    // pickup and collision collects it.
    if (
      distance <= CLOSE_APPROACH_DIRECT_FT &&
      hasClearLineOfSight(world.floorMap, playerX, playerY, targetX, targetY)
    ) {
      this.pathWaypoints = [];
      this.pathIndex = 0;
      this.pathGoalKey = null;
      this.moveWithLocalNavigation(
        state,
        world,
        playerX,
        playerY,
        deltaX / distance,
        deltaY / distance,
      );
      return;
    }

    const floorMap = world.floorMap;
    if (floorMap) {
      const startTile = floorMap.worldToTile(playerX, playerY);
      const goalTile = floorMap.worldToTile(targetX, targetY);
      const rawGoalKey = `${goalTile.x},${goalTile.y}`;
      let resolvedGoal: TilePoint;
      if (this.resolvedGoalCache?.rawKey === rawGoalKey) {
        // Cache hit: the goal tile is the same as last frame and we previously
        // confirmed the direct path was reachable (cache is only populated for
        // the direct-path case; fallback results are start-position-dependent).
        resolvedGoal = this.resolvedGoalCache.resolved;
      } else {
        resolvedGoal = this.resolveReachableGoalTile(floorMap, startTile, goalTile);
        // Only cache the direct-path result (resolved == raw goal). Fallback
        // results depend on start position and must be recomputed each frame.
        if (resolvedGoal.x === goalTile.x && resolvedGoal.y === goalTile.y) {
          this.resolvedGoalCache = { rawKey: rawGoalKey, resolved: resolvedGoal };
        } else {
          this.resolvedGoalCache = null;
        }
      }
      const goalKey = `${resolvedGoal.x},${resolvedGoal.y}`;

      if (this.pathGoalKey !== goalKey || this.pathWaypoints.length === 0) {
        const path = findTilePath(floorMap, startTile, resolvedGoal, this.groundPathOptions());

        if (path.length > 1) {
          this.pathWaypoints = path;
          const nextIndex = path.findIndex(
            (tile) => tile.x !== startTile.x || tile.y !== startTile.y,
          );
          this.pathIndex = nextIndex === -1 ? 1 : nextIndex;
          this.pathGoalKey = goalKey;
          this.moveWedgeFrames = 0;
          if (this.config.debug) {
            logger.debug('AI computed path', { length: path.length, goalKey });
          }
        } else {
          this.pathWaypoints = [];
          this.pathIndex = 0;
          this.pathGoalKey = null;
          if (this.decision.state === AIState.COLLECT && this.decision.targetEid !== null) {
            this.ignoredLootUntilFrame.set(this.decision.targetEid, world.frameCount + 300);
            this.decision.targetEid = null;
            this.decision.targetX = null;
            this.decision.targetY = null;
            state.moveX = 0;
            state.moveY = 0;
            return;
          }
          // Abandon the EXPLORE target immediately when A* finds no path. If the
          // target is unreachable (e.g. behind a locked door), falling through to
          // moveWithLocalNavigation causes large-amplitude wiggling that repeatedly
          // resets the DwellTracker escape circle, preventing the watchdog from
          // ever firing. Clearing the target here stops the wiggle and lets the
          // DwellTracker accumulate until it suppresses the progress goal so the AI
          // can explore elsewhere.
          if (this.decision.state === AIState.EXPLORE) {
            this.decision.targetX = null;
            this.decision.targetY = null;
            state.moveX = 0;
            state.moveY = 0;
            return;
          }
        }
      }
    }

    // Follow path if we have one
    if (this.pathWaypoints.length > 0 && this.pathIndex < this.pathWaypoints.length) {
      // String-pull the 4-connected A* path so the AI cuts diagonally toward the
      // farthest waypoint it can see, instead of stair-stepping cardinal hops.
      if (floorMap) {
        this.smoothPathIndex(world, floorMap, playerX, playerY);
      }
      const waypoint = this.pathWaypoints[this.pathIndex];
      if (!waypoint) {
        this.pathWaypoints = [];
        this.pathIndex = 0;
        this.pathGoalKey = null;
      } else {
        const waypointWorld = floorMap ? floorMap.tileToWorld(waypoint.x, waypoint.y) : null;
        if (!waypointWorld) {
          this.pathWaypoints = [];
          this.pathIndex = 0;
          this.pathGoalKey = null;
          return;
        }
        const waypointDist = Math.hypot(playerX - waypointWorld.x, playerY - waypointWorld.y);

        if (waypointDist < WAYPOINT_ARRIVE_FT) {
          // Reached waypoint - move to next
          this.pathIndex++;
          if (this.pathIndex >= this.pathWaypoints.length) {
            this.pathWaypoints = [];
            this.pathIndex = 0;
            this.pathGoalKey = null;
          }
        } else {
          // Wedge recovery: while aiming at this waypoint, watch real positional
          // progress. If collision pins the player in place (a doorway/corner
          // choke), skip the stuck waypoint and slide with local obstacle
          // avoidance so it threads the gap instead of vibrating short of it.
          const movedSinceLast = Number.isNaN(this.moveWedgeLastX)
            ? Number.POSITIVE_INFINITY
            : Math.hypot(playerX - this.moveWedgeLastX, playerY - this.moveWedgeLastY);
          this.moveWedgeLastX = playerX;
          this.moveWedgeLastY = playerY;
          if (movedSinceLast < MOVE_WEDGE_PROGRESS_FT) {
            this.moveWedgeFrames++;
          } else {
            this.moveWedgeFrames = 0;
          }

          if (this.moveWedgeFrames >= MOVE_WEDGE_FRAMES) {
            this.moveWedgeFrames = 0;
            this.pathIndex++;
            if (this.pathIndex >= this.pathWaypoints.length) {
              // No further waypoint to thread toward: drop the path and slide
              // straight at the final target with obstacle avoidance.
              this.pathWaypoints = [];
              this.pathIndex = 0;
              this.pathGoalKey = null;
            }
            this.moveWithLocalNavigation(
              state,
              world,
              playerX,
              playerY,
              deltaX / distance,
              deltaY / distance,
            );
            return;
          }

          // Move toward current waypoint
          const normalized = normalizeInputDirection(
            (waypointWorld.x - playerX) / waypointDist,
            (waypointWorld.y - playerY) / waypointDist,
          );
          state.moveX = normalized.moveX;
          state.moveY = normalized.moveY;
          return;
        }
      }
    }

    // Fallback: direct movement toward target. In ENGAGE mode, prefer the
    // enemy's current world position over the plan target so the player closes
    // the sub-tile gap precisely — mirrors the enemy AI's direct pursuit when
    // its path waypoints are exhausted but the player has drifted within the
    // tile (see enemyAISystem "Tile center already reached" fix).
    if (this.decision.state === AIState.ENGAGE && this.decision.targetEid !== null) {
      const pursuit = this.enemyPursuitDirection(world, playerX, playerY, this.decision.targetEid);
      if (pursuit !== null) {
        this.moveWithLocalNavigation(
          state,
          world,
          playerX,
          playerY,
          pursuit.dx / pursuit.dist,
          pursuit.dy / pursuit.dist,
        );
        return;
      }
    }
    this.moveWithLocalNavigation(
      state,
      world,
      playerX,
      playerY,
      deltaX / distance,
      deltaY / distance,
    );
  }

  /**
   * No-op retained for API compatibility: navmesh-routed pathing modes were
   * removed, so there is no cached navmesh state left to free.
   */
  disposeNavmesh(): void {}

  private resolveReachableGoalTile(
    floorMap: FloorMap,
    startTile: TilePoint,
    goalTile: TilePoint,
    maxRadius: number = PATH_GOAL_SEARCH_RADIUS_TILES,
  ): TilePoint {
    // Drop the memo whenever the passable graph could have changed; within a
    // single epoch every (start, goal, radius) result is stable.
    if (this.resolveGoalMemoEpoch !== this.navEpoch) {
      this.resolveGoalMemo.clear();
      this.resolveGoalMemoEpoch = this.navEpoch;
    }
    const memoKey = `${startTile.x},${startTile.y},${goalTile.x},${goalTile.y},${maxRadius}`;
    const cached = this.resolveGoalMemo.get(memoKey);
    if (cached) {
      return cached;
    }

    const resolved = this.computeReachableGoalTile(floorMap, startTile, goalTile, maxRadius);
    if (this.resolveGoalMemo.size >= RESOLVE_GOAL_MEMO_MAX) {
      this.resolveGoalMemo.clear();
    }
    this.resolveGoalMemo.set(memoKey, resolved);
    return resolved;
  }

  private computeReachableGoalTile(
    floorMap: FloorMap,
    startTile: TilePoint,
    goalTile: TilePoint,
    maxRadius: number = PATH_GOAL_SEARCH_RADIUS_TILES,
  ): TilePoint {
    // Reachability and shortest-path length over the door-aware passable graph,
    // computed with a single breadth-first flood from the start tile. The prior
    // implementation called {@link findTilePath} (rot-js A*) once for the direct
    // goal and again for every tile on each expanding ring (up to ~169 A*
    // searches per resolve, each O(n^2) on the open list and flooding the whole
    // floor on a miss). Because the A* uses topology 4 with uniform step cost,
    // its returned path length is always the optimal distance, which equals this
    // BFS depth + 1 -- so ranking candidates by BFS depth reproduces the exact
    // same selection while doing O(tiles) work once instead of an A* per
    // candidate. NAVIGATION_MAX_PATH_LENGTH bounds the flood depth identically to
    // findTilePath's maxPathLength rejection of longer paths.
    const tileMap = floorMap.tileMap;
    const width = tileMap.width;
    const height = tileMap.height;
    const passable =
      this.doorAwarePassable ?? ((tx: number, ty: number): boolean => tileMap.isPassable(tx, ty));

    // findTilePath returns [] when the start tile itself is not traversable, so
    // every direct and ring search would fail -> resolve to the raw goal.
    if (!tileMap.inBounds(startTile.x, startTile.y) || !passable(startTile.x, startTile.y)) {
      return goalTile;
    }

    const dist = new Int32Array(width * height).fill(-1);
    const queue = new Int32Array(width * height);
    const maxDepth = NAVIGATION_MAX_PATH_LENGTH - 1;
    const startIndex = startTile.y * width + startTile.x;
    floodReachabilityDepth(dist, queue, width, height, startIndex, maxDepth, passable);

    // path length to a tile == findTilePath(start, tile).length, or 0 if the tile
    // is unreachable within NAVIGATION_MAX_PATH_LENGTH.
    const pathLengthTo = (x: number, y: number): number => {
      // Bounds-check before indexing `dist`: goal tiles are not clamped to the
      // map (FloorMap.worldToTile can return out-of-bounds coords), and an
      // out-of-bounds (x, y) can still yield an in-bounds linear index
      // `y * width + x` that aliases an unrelated reachable tile. findTilePath
      // rejects out-of-bounds goals, so mirror that here -- treat them as
      // unreachable so the ring fallback runs instead of returning a phantom
      // "direct" hit the caller cannot actually path to.
      if (x < 0 || y < 0 || x >= width || y >= height) {
        return 0;
      }
      const d = dist[y * width + x]!;
      return d < 0 ? 0 : d + 1;
    };

    // Direct path available (findTilePath would return length > 1).
    if (pathLengthTo(goalTile.x, goalTile.y) > 1) {
      return goalTile;
    }

    let bestGoal: TilePoint | null = null;
    let bestPathLength = Number.POSITIVE_INFINITY;
    let bestDistanceScore = Number.POSITIVE_INFINITY;

    for (let radius = 1; radius <= maxRadius; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) {
            continue;
          }

          const candidate = { x: goalTile.x + dx, y: goalTile.y + dy };
          if (!tileMap.inBounds(candidate.x, candidate.y)) {
            continue;
          }
          if (!tileMap.isPassable(candidate.x, candidate.y)) {
            continue;
          }

          const pathLength = pathLengthTo(candidate.x, candidate.y);
          if (pathLength <= 1) {
            continue;
          }

          const distanceScore = Math.abs(dx) + Math.abs(dy);
          if (
            pathLength < bestPathLength ||
            (pathLength === bestPathLength && distanceScore < bestDistanceScore)
          ) {
            bestGoal = candidate;
            bestPathLength = pathLength;
            bestDistanceScore = distanceScore;
          }
        }
      }
    }

    return bestGoal ?? goalTile;
  }

  /**
   * String-pulling path smoothing. {@link findTilePath} is 4-connected, so its
   * waypoints stair-step in cardinal hops; following them one at a time yields
   * the characteristic right-angle motion. Advance {@link pathIndex} to the
   * farthest upcoming waypoint the player has an unobstructed straight line to,
   * so the AI steers diagonally across open ground. The line-of-sight check
   * keeps it from cutting through walls; wedge recovery and the local-navigation
   * fallback handle any corner it does clip.
   */
  private smoothPathIndex(
    world: GameWorld,
    floorMap: FloorMap,
    playerX: number,
    playerY: number,
  ): void {
    // Scan backward from the path end to find the farthest visible waypoint in a
    // single pass, maximizing diagonal shortcuts while preserving wall safety.
    for (let i = this.pathWaypoints.length - 1; i > this.pathIndex; i--) {
      const wp = this.pathWaypoints[i];
      if (!wp) {
        continue;
      }
      const wpWorld = floorMap.tileToWorld(wp.x, wp.y);
      if (hasClearLineOfSight(world.floorMap, playerX, playerY, wpWorld.x, wpWorld.y)) {
        this.pathIndex = i;
        return;
      }
    }
  }

  private moveWithLocalNavigation(
    state: InputState,
    world: GameWorld,
    playerX: number,
    playerY: number,
    desiredX: number,
    desiredY: number,
  ): void {
    const desiredLength = Math.hypot(desiredX, desiredY);
    if (desiredLength <= 0.0001) {
      state.moveX = 0;
      state.moveY = 0;
      return;
    }

    const baseX = desiredX / desiredLength;
    const baseY = desiredY / desiredLength;
    const floorMap = world.floorMap;

    if (floorMap) {
      for (const offset of NAVIGATION_ANGLE_OFFSETS) {
        const candidateX = baseX * Math.cos(offset) - baseY * Math.sin(offset);
        const candidateY = baseX * Math.sin(offset) + baseY * Math.cos(offset);
        const sampleX = playerX + candidateX * NAVIGATION_LOOKAHEAD_FT;
        const sampleY = playerY + candidateY * NAVIGATION_LOOKAHEAD_FT;
        if (floorMap.isPassableAt(sampleX, sampleY)) {
          const normalized = normalizeInputDirection(candidateX, candidateY);
          state.moveX = normalized.moveX;
          state.moveY = normalized.moveY;
          return;
        }
      }
    }

    const normalized = normalizeInputDirection(baseX, baseY);
    state.moveX = normalized.moveX;
    state.moveY = normalized.moveY;
  }

  private findNearestEnemy(
    world: GameWorld,
    playerX: number,
    playerY: number,
    maxRadius: number = this.config.scanRadius,
    includeIgnored: boolean = false,
    excludeEid: number = -1,
  ): WorldTarget | null {
    const enemies = query(world.ecs, [Enemy, Position, Health]);
    const candidates: WorldTarget[] = [];

    for (const eid of enemies) {
      if (eid === undefined) continue;
      if (eid === excludeEid) continue;
      if (!isEnemyCombatEligible(world, eid)) continue;

      const ignoredUntil = this.ignoredEnemyUntilFrame.get(eid);
      if (ignoredUntil !== undefined) {
        if (ignoredUntil > world.frameCount) {
          if (!includeIgnored) continue;
        } else {
          this.ignoredEnemyUntilFrame.delete(eid);
        }
      }

      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      const health = world.stores.health.current[eid] ?? 0;

      if (health <= 0) continue;
      if (!this.canPerceiveWorldPosition(world, x, y)) continue;

      const dist = Math.hypot(x - playerX, y - playerY);
      if (dist <= maxRadius) {
        candidates.push({ eid, x, y, distance: dist });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);

    // Return the nearest enemy we can actually path to. Skipping unreachable
    // enemies (e.g. behind walls or in an unopened room) lets the behavior tree
    // fall through to Explore, which A*-routes to a reachable area instead of
    // local-navigating straight into a wall and wiggling forever.
    for (const candidate of candidates) {
      if (candidate.distance <= DIRECT_MOVE_EPSILON_FT) {
        return candidate;
      }
      if (this.isTargetReachable(world, playerX, playerY, candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Nearest *living, reachable* boss-unlock quest enemy — an ambient-swarm
   * rat/slime registered in {@link GameWorld.floorScenario}'s `enemyArchetypes`. Only
   * these registered enemies advance the 6-rat/4-slime kill quota; a kill counts
   * only when one dies in combat (out-of-range despawns are pruned without
   * counting). Mirrors {@link findNearestEnemy}'s reachability filtering so a
   * quest enemy behind an unopened room falls through to Explore (which uncovers
   * the map toward it) instead of wedging the AI against a wall. Defaults to an
   * unbounded radius because the swarm can drift across the floor and the AI must
   * still commit to hunting it rather than treating it as "too far to bother".
   */
  private findNearestQuestEnemy(
    world: GameWorld,
    playerX: number,
    playerY: number,
    maxRadius: number = Number.POSITIVE_INFINITY,
  ): WorldTarget | null {
    const floorScenario = world.floorScenario;
    if (!floorScenario) {
      return null;
    }

    const candidates: WorldTarget[] = [];
    for (const eid of floorScenario.enemyArchetypes.keys()) {
      if (!entityExists(world.ecs, eid)) continue;

      const ignoredUntil = this.ignoredEnemyUntilFrame.get(eid);
      if (ignoredUntil !== undefined) {
        if (ignoredUntil > world.frameCount) continue;
        this.ignoredEnemyUntilFrame.delete(eid);
      }

      const health = world.stores.health.current[eid] ?? 0;
      if (health <= 0) continue;

      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      if (!this.canPerceiveWorldPosition(world, x, y)) continue;
      const dist = Math.hypot(x - playerX, y - playerY);
      if (dist <= maxRadius) {
        candidates.push({ eid, x, y, distance: dist });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);

    for (const candidate of candidates) {
      if (candidate.distance <= DIRECT_MOVE_EPSILON_FT) {
        return candidate;
      }
      if (this.isTargetReachable(world, playerX, playerY, candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private parseFloor2FamilyId(questId: string): string | null {
    const match = /^floor2-den-(.+)-unlock$/.exec(questId);
    return match ? (match[1] ?? null) : null;
  }

  private resetFloor2HuntStateForMap(world: GameWorld): void {
    if (this.floor2HuntMap === world.floorMap) {
      return;
    }
    this.floor2HuntMap = world.floorMap;
    this.floor2HuntFamilyId = null;
    this.floor2HuntPatrolIndex = 0;
    this.floor2HuntPatrolTarget = null;
    this.floor2HuntLastKillCount = 0;
    this.floor2HuntLastProgressFrame = world.frameCount;
    this.floor2HuntCadenceStartFrame = world.frameCount;
    this.floor2HuntHandledSuppressionUntilFrame = 0;
    this.floor2HuntPatrolTiles.clear();
  }

  private getFloor2TerritoryZone(world: GameWorld, familyId: FamilyId): TerritoryZone | null {
    const familyState = world.floorExtendedState?.familyState;
    const familyIndex = familyState?.presentFamilies.findIndex((id) => id === familyId) ?? -1;
    if (familyIndex < 0) {
      return null;
    }
    return world.floorMap?.territoryZones.find((zone) => zone.familyIndex === familyIndex) ?? null;
  }

  private isWorldPositionInFloor2TerritoryZone(
    world: GameWorld,
    zone: TerritoryZone,
    x: number,
    y: number,
  ): boolean {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return false;
    }
    const tile = floorMap.worldToTile(x, y);
    const dx = tile.x - zone.centerX;
    const dy = tile.y - zone.centerY;
    return dx * dx + dy * dy <= zone.radius * zone.radius;
  }

  private getFloor2HuntPatrolTiles(
    world: GameWorld,
    familyId: FamilyId,
    zone: TerritoryZone,
  ): readonly TilePoint[] {
    const cached = this.floor2HuntPatrolTiles.get(familyId);
    if (cached) {
      return cached;
    }
    const floorMap = world.floorMap;
    const familyState = world.floorExtendedState?.familyState;
    const familyIndex = familyState?.presentFamilies.findIndex((id) => id === familyId) ?? -1;
    if (!floorMap || familyIndex < 0) {
      return [];
    }
    const cells: TilePoint[] = [];
    for (let y = zone.centerY - zone.radius; y <= zone.centerY + zone.radius; y += 1) {
      for (let x = zone.centerX - zone.radius; x <= zone.centerX + zone.radius; x += 1) {
        const dx = x - zone.centerX;
        const dy = y - zone.centerY;
        if (
          dx * dx + dy * dy > zone.radius * zone.radius ||
          !floorMap.tileMap.inBounds(x, y) ||
          !floorMap.tileMap.isPassable(x, y)
        ) {
          continue;
        }
        const roomId = floorMap.roomGraph.getRoomAt(x, y);
        if (roomId >= 0 && floorMap.roomGraph.get(roomId)?.role === RoomRole.BOSS_DEN) {
          continue;
        }
        cells.push({ x, y });
      }
    }
    if (cells.length === 0) {
      this.floor2HuntPatrolTiles.set(familyId, []);
      return [];
    }

    const radius = zone.radius * FLOOR2_HUNT_PATROL_RADIUS_FRACTION;
    const directions = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: -1, y: -1 },
      { x: -1, y: 1 },
      { x: 1, y: -1 },
    ] as const;
    const patrolTiles: TilePoint[] = [];
    const used = new Set<string>();
    const unresolvedZones = floorMap.territoryZones.filter((candidateZone) => {
      const candidateFamilyId = familyState?.presentFamilies[candidateZone.familyIndex];
      return (
        candidateFamilyId !== undefined &&
        familyState?.bossEncounters?.get(candidateFamilyId)?.defeated !== true &&
        familyState?.decapitatedFamilies?.has(candidateFamilyId) !== true
      );
    });
    const scoredCells = cells.map((cell) => ({
      cell,
      overlap: unresolvedZones.reduce((count, candidateZone) => {
        const dx = cell.x - candidateZone.centerX;
        const dy = cell.y - candidateZone.centerY;
        return count + (dx * dx + dy * dy <= candidateZone.radius * candidateZone.radius ? 1 : 0);
      }, 0),
    }));
    const appendDirectionalTiles = (requireOverlap: boolean): void => {
      for (const direction of directions) {
        const magnitude = Math.hypot(direction.x, direction.y);
        const desiredX = zone.centerX + (direction.x / magnitude) * radius;
        const desiredY = zone.centerY + (direction.y / magnitude) * radius;
        const nearest = scoredCells
          .filter(
            ({ cell, overlap }) =>
              !used.has(`${cell.x},${cell.y}`) && (!requireOverlap || overlap > 1),
          )
          .map(({ cell, overlap }) => ({
            cell,
            overlap,
            distanceSq: (cell.x - desiredX) ** 2 + (cell.y - desiredY) ** 2,
          }))
          .sort(
            (a, b) =>
              (requireOverlap ? b.overlap - a.overlap : 0) ||
              a.distanceSq - b.distanceSq ||
              a.cell.y - b.cell.y ||
              a.cell.x - b.cell.x,
          )[0]?.cell;
        if (nearest) {
          patrolTiles.push({ x: nearest.x, y: nearest.y });
          used.add(`${nearest.x},${nearest.y}`);
        }
      }
    };
    appendDirectionalTiles(true);
    appendDirectionalTiles(false);
    this.floor2HuntPatrolTiles.set(familyId, patrolTiles);
    return patrolTiles;
  }

  private advanceFloor2HuntPatrol(): void {
    this.floor2HuntPatrolIndex += 1;
    this.floor2HuntPatrolTarget = null;
  }

  private resolveFloor2HuntPatrolTarget(
    world: GameWorld,
    familyId: FamilyId,
    zone: TerritoryZone,
    playerX: number,
    playerY: number,
  ): ProgressTarget | null {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return null;
    }
    const patrolTiles = this.getFloor2HuntPatrolTiles(world, familyId, zone);
    if (patrolTiles.length === 0) {
      return null;
    }
    if (this.floor2HuntPatrolTarget) {
      const currentWorld = floorMap.tileToWorld(
        this.floor2HuntPatrolTarget.x,
        this.floor2HuntPatrolTarget.y,
      );
      if (
        Math.hypot(currentWorld.x - playerX, currentWorld.y - playerY) <=
        FLOOR2_HUNT_PATROL_ARRIVE_FT
      ) {
        this.advanceFloor2HuntPatrol();
      }
    }
    if (!this.floor2HuntPatrolTarget) {
      const startTile = floorMap.worldToTile(playerX, playerY);
      for (let offset = 0; offset < patrolTiles.length; offset += 1) {
        const index = (this.floor2HuntPatrolIndex + offset) % patrolTiles.length;
        const candidate = patrolTiles[index]!;
        if (candidate.x === startTile.x && candidate.y === startTile.y) {
          continue;
        }
        const path = findTilePath(floorMap, startTile, candidate, this.groundPathOptions());
        if (path.length <= 1) {
          continue;
        }
        this.floor2HuntPatrolIndex = index;
        this.floor2HuntPatrolTarget = candidate;
        break;
      }
    }
    if (!this.floor2HuntPatrolTarget) {
      return null;
    }
    const targetWorld = floorMap.tileToWorld(
      this.floor2HuntPatrolTarget.x,
      this.floor2HuntPatrolTarget.y,
    );
    return this.createProgressTarget(
      targetWorld.x,
      targetWorld.y,
      playerX,
      playerY,
      `Hunting ${familyId} inside its territory`,
    );
  }

  private commitFloor2HuntFamily(world: GameWorld, familyId: FamilyId): void {
    this.floor2HuntFamilyId = familyId;
    this.floor2HuntPatrolIndex = 0;
    this.floor2HuntPatrolTarget = null;
    this.floor2HuntLastKillCount =
      world.floorExtendedState?.familyState?.trashKillsByFamily?.get(familyId) ?? 0;
    this.floor2HuntLastProgressFrame = world.frameCount;
    this.floor2HuntCadenceStartFrame = world.frameCount;
    this.floor2HuntHandledSuppressionUntilFrame = 0;
  }

  private isFloor2HuntRecoveryWindow(world: GameWorld): boolean {
    const durationMs = getFloorManifest('floor2')?.timer?.durationMs;
    if (
      world.floorId === 'floor2' &&
      durationMs !== undefined &&
      durationMs - world.elapsedMs <= FLOOR2_HUNT_URGENCY_REMAINING_MS
    ) {
      return false;
    }
    const cycleFrames = FLOOR2_HUNT_ENGAGE_FRAMES + FLOOR2_HUNT_RECOVERY_FRAMES;
    const elapsedFrames = Math.max(0, world.frameCount - this.floor2HuntCadenceStartFrame);
    return elapsedFrames % cycleFrames >= FLOOR2_HUNT_ENGAGE_FRAMES;
  }

  private selectFloor2HuntFamily(world: GameWorld): FamilyId | null {
    this.resetFloor2HuntStateForMap(world);
    const floor2State = world.floorExtendedState?.familyState;
    if (!floor2State || floor2State.presentFamilies.length === 0) {
      return null;
    }
    const isResolved = (familyId: FamilyId): boolean =>
      floor2State.bossEncounters?.get(familyId)?.defeated === true ||
      floor2State.decapitatedFamilies?.has(familyId) === true;
    if (this.floor2HuntFamilyId && !isResolved(this.floor2HuntFamilyId)) {
      return this.floor2HuntFamilyId;
    }

    const playerEid = query(world.ecs, [Player, Position])[0];
    const playerX = playerEid === undefined ? 0 : (world.stores.position.x[playerEid] ?? 0);
    const playerY = playerEid === undefined ? 0 : (world.stores.position.y[playerEid] ?? 0);
    const nextFamily = floor2State.presentFamilies
      .map((familyId, index) => ({
        familyId,
        index,
        unlocked: world.goalFlags.get(denUnlockGoalId(familyId)) === true,
        kills: floor2State.trashKillsByFamily?.get(familyId) ?? 0,
        distance: (() => {
          const zone = this.getFloor2TerritoryZone(world, familyId);
          if (!zone || !world.floorMap) {
            return Number.POSITIVE_INFINITY;
          }
          const center = world.floorMap.tileToWorld(zone.centerX, zone.centerY);
          return Math.hypot(center.x - playerX, center.y - playerY);
        })(),
      }))
      .filter(({ familyId }) => !isResolved(familyId))
      .sort(
        (a, b) =>
          Number(b.unlocked) - Number(a.unlocked) ||
          a.distance - b.distance ||
          b.kills - a.kills ||
          a.index - b.index,
      )[0]?.familyId;
    if (!nextFamily) {
      this.floor2HuntFamilyId = null;
      return null;
    }
    this.commitFloor2HuntFamily(world, nextFamily);
    return nextFamily;
  }

  private updateFloor2HuntProgress(world: GameWorld, familyId: FamilyId): boolean {
    const killCount = world.floorExtendedState?.familyState?.trashKillsByFamily?.get(familyId) ?? 0;
    if (killCount > this.floor2HuntLastKillCount) {
      this.floor2HuntLastKillCount = killCount;
      this.floor2HuntLastProgressFrame = world.frameCount;
    }
    if (
      world.frameCount < this.progressGoalSuppressedUntilFrame &&
      this.floor2HuntHandledSuppressionUntilFrame !== this.progressGoalSuppressedUntilFrame
    ) {
      this.floor2HuntHandledSuppressionUntilFrame = this.progressGoalSuppressedUntilFrame;
      this.advanceFloor2HuntPatrol();
    }
    if (world.frameCount - this.floor2HuntLastProgressFrame < FLOOR2_HUNT_NO_PROGRESS_FRAMES) {
      return true;
    }

    this.floor2HuntLastProgressFrame = world.frameCount;
    this.advanceFloor2HuntPatrol();
    return true;
  }

  private findNearestFloor2HuntEnemy(
    world: GameWorld,
    familyId: FamilyId | null,
    playerX: number,
    playerY: number,
    maxRadius: number = Number.POSITIVE_INFINITY,
    requirePerception: boolean = true,
    territoryZone?: TerritoryZone,
  ): WorldTarget | null {
    const floor2State = world.floorExtendedState?.familyState;
    const familyIndex =
      familyId === null
        ? -1
        : (floor2State?.presentFamilies.findIndex((id: string) => id === familyId) ?? -1);
    if (familyId !== null && familyIndex < 0) {
      return null;
    }

    const familyField = world.stores.familyMembership.familyId;
    const bossField = world.stores.familyMembership.isBoss;
    const readCandidate = (eid: number): WorldTarget | null => {
      if (
        !entityExists(world.ecs, eid) ||
        !hasComponent(world.ecs, eid, Enemy) ||
        !hasComponent(world.ecs, eid, Position) ||
        !hasComponent(world.ecs, eid, Health)
      ) {
        return null;
      }
      if (
        familyId !== null &&
        (!hasComponent(world.ecs, eid, FamilyMembership) ||
          (familyField[eid] ?? -1) !== familyIndex)
      ) {
        return null;
      }
      if ((bossField[eid] ?? 0) !== 0 || (world.stores.health.current[eid] ?? 0) <= 0) {
        return null;
      }
      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      if (territoryZone && !this.isWorldPositionInFloor2TerritoryZone(world, territoryZone, x, y)) {
        return null;
      }
      if (requirePerception && !this.canPerceiveWorldPosition(world, x, y)) {
        return null;
      }
      const distance = Math.hypot(x - playerX, y - playerY);
      return distance <= maxRadius ? { eid, x, y, distance } : null;
    };

    const candidates: WorldTarget[] = [];
    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      if (eid === undefined) continue;
      const candidate = readCandidate(eid);
      if (candidate) candidates.push(candidate);
    }

    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates) {
      if (candidate.distance <= DIRECT_MOVE_EPSILON_FT) {
        return candidate;
      }
      if (this.isTargetReachable(world, playerX, playerY, candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private findNearestFloor2Boss(
    world: GameWorld,
    playerX: number,
    playerY: number,
    familyId?: string,
    maxRadius: number = Number.POSITIVE_INFINITY,
    requirePerception: boolean = true,
  ): WorldTarget | null {
    const floor2State = world.floorExtendedState?.familyState;
    const decapitated = floor2State?.decapitatedFamilies;
    const familyIndex = familyId
      ? (floor2State?.presentFamilies.findIndex((id: string) => id === familyId) ?? -1)
      : -1;
    const candidates: WorldTarget[] = [];
    const familyField = world.stores.familyMembership.familyId;
    const bossField = world.stores.familyMembership.isBoss;

    for (const eid of query(world.ecs, [Enemy, Position, Health, FamilyMembership])) {
      if (eid === undefined) continue;
      if ((bossField[eid] ?? 0) !== 1) continue;
      const bossFamilyIndex = familyField[eid] ?? -1;
      if (familyId !== undefined && bossFamilyIndex !== familyIndex) continue;
      const bossFamilyId = floor2State?.presentFamilies[bossFamilyIndex];
      if (
        bossFamilyId === undefined ||
        world.goalFlags.get(denUnlockGoalId(bossFamilyId)) !== true
      ) {
        continue;
      }
      if (bossFamilyId !== undefined && decapitated?.has(bossFamilyId)) continue;
      const health = world.stores.health.current[eid] ?? 0;
      if (health <= 0) continue;
      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      if (requirePerception && !this.canPerceiveWorldPosition(world, x, y)) continue;
      const dist = Math.hypot(x - playerX, y - playerY);
      if (dist <= maxRadius) {
        candidates.push({ eid, x, y, distance: dist });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);
    const nearest = candidates[0] ?? null;
    for (const candidate of candidates) {
      if (candidate.distance <= DIRECT_MOVE_EPSILON_FT) {
        return candidate;
      }
      if (this.isTargetReachable(world, playerX, playerY, candidate)) {
        return candidate;
      }
    }
    return nearest;
  }

  private findNearestQuestItem(
    world: GameWorld,
    itemId: string,
    playerX: number,
    playerY: number,
    maxRadius: number = this.config.scanRadius * 2,
  ): LootTarget | null {
    if (!getItemById(itemId)) {
      return null;
    }

    const candidates: LootTarget[] = [];
    for (const eid of query(world.ecs, [DroppedItem, Position])) {
      if (eid === undefined) continue;
      const droppedIndex = world.stores.droppedItem.itemIndex[eid];
      if (droppedIndex === undefined) continue;
      const droppedItem = getItemByIndex(droppedIndex);
      if (!droppedItem || droppedItem.id !== itemId) continue;
      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      const dist = Math.hypot(x - playerX, y - playerY);
      if (dist < maxRadius) {
        candidates.push({ eid, x, y, distance: dist, kind: 'item' });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates) {
      if (this.isLootCollectable(world, playerX, playerY, candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private isFloor2IntroductionPending(world: GameWorld): boolean {
    return (
      world.floorExtendedState?.familyState != null &&
      (world.goalFlags.get(FLOOR2_SETTLEMENT_FOUND_GOAL_ID) !== true ||
        world.goalFlags.get(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID) !== true)
    );
  }

  private findFloor2ProgressObjective(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
  ): ProgressTarget | null {
    const floor2State = world.floorExtendedState?.familyState;
    const settlement = world.floorExtendedState?.settlement;
    const settlementAnchor = resolveFloor2SettlementAnchor(world);
    const settlementFound = world.goalFlags.get(FLOOR2_SETTLEMENT_FOUND_GOAL_ID) === true;
    const progressSuppressed = world.frameCount < this.progressGoalSuppressedUntilFrame;
    if (!settlementFound) {
      if (progressSuppressed) {
        return null;
      }
      return settlementAnchor
        ? this.createProgressTarget(
            settlementAnchor.x,
            settlementAnchor.y,
            playerX,
            playerY,
            'Heading to the Floor 2 settlement',
          )
        : null;
    }

    const brokerIntroduced = world.goalFlags.get(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID) === true;
    if (!brokerIntroduced) {
      if (progressSuppressed) {
        return null;
      }
      if (!settlementAnchor) {
        return null;
      }
      return this.createNpcProgressTarget(
        world,
        playerX,
        playerY,
        settlement?.brokerEid ?? -1,
        'Heading to the Floor 2 Broker introduction',
        settlementAnchor.x,
        settlementAnchor.y,
        AINpcInteractionAction.MEET_BROKER_INTRO,
      );
    }

    if (
      floor2State?.staircaseSpawned &&
      floor2State.staircaseUnlocked &&
      !floor2State.staircaseDiscovered &&
      floor2State.staircasePos
    ) {
      if (progressSuppressed) {
        return null;
      }
      return this.createProgressTarget(
        floor2State.staircasePos.x,
        floor2State.staircasePos.y,
        playerX,
        playerY,
        'Heading to the Floor 2 exit stairs',
      );
    }

    // Optional latched settlement-return goal: only intercepts Progress when
    // `settlement-return-router` has ARMED or is already TRAVELING (danger
    // and unreachability abort conditions are evaluated by the router itself,
    // upstream, once per poll — see the unconditional pre-tick hook above).
    // Deliberately placed below the mandatory settlement/broker/staircase
    // objectives (those always win) and above hunting (this is what actually
    // gets pre-empted), matching the plan's "optional, subordinate to
    // required progress" requirement. READ only — never mutates the router.
    //
    // Unlike the mandatory branches above, a suppressed-but-not-armed router
    // must NOT `return null` here — that would swallow the *entire* function,
    // silently blocking the boss-hunt logic below even though this optional
    // branch was never going to fire. Instead, `!progressSuppressed` is
    // folded into this branch's own condition so an ineligible/idle router
    // simply falls through to hunting, exactly as if this branch didn't
    // exist.
    const settlementReturnIntent = getSettlementReturnIntent(world);
    if (
      !progressSuppressed &&
      (settlementReturnIntent.status === 'armed' ||
        settlementReturnIntent.status === 'traveling') &&
      settlementAnchor
    ) {
      return this.createProgressTarget(
        settlementAnchor.x,
        settlementAnchor.y,
        playerX,
        playerY,
        'Returning to the settlement to run maintenance (equip/shop/claim)',
      );
    }

    const huntFamilyId = this.selectFloor2HuntFamily(world);
    if (!huntFamilyId) {
      return null;
    }
    const denUnlocked = world.goalFlags.get(denUnlockGoalId(huntFamilyId)) === true;
    if (denUnlocked) {
      const boss =
        this.findNearestFloor2Boss(world, playerX, playerY, huntFamilyId) ??
        this.findNearestFloor2Boss(
          world,
          playerX,
          playerY,
          huntFamilyId,
          Number.POSITIVE_INFINITY,
          false,
        );
      if (!boss) return null;
      // When progress is suppressed, only navigate to a reachable boss.  An
      // unreachable pre-encounter boss (eid: -1 EXPLORE target) would be
      // immediately reselected as the same fixed goal the watchdog is pausing,
      // causing the no-path clear/reselect loop to continue.
      if (progressSuppressed && !this.isTargetReachable(world, playerX, playerY, boss)) {
        return null;
      }
      return this.createFloor2BossProgressTarget(
        world,
        huntFamilyId,
        boss,
        playerX,
        playerY,
        `Entering the ${huntFamilyId} den to confront its boss`,
      );
    }

    const quest = world.questLog.get(`floor2-den-${huntFamilyId}-unlock`);
    if (!quest || quest.status !== 'active') {
      return null;
    }
    return this.findFloor2QuestProgressTarget(
      world,
      playerEid,
      playerX,
      playerY,
      quest,
      progressSuppressed,
    );
  }

  private findFloor2QuestProgressTarget(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
    activeQuest: QuestState,
    progressSuppressed: boolean,
  ): ProgressTarget | null {
    const parsedFamilyId = this.parseFloor2FamilyId(activeQuest.questId);
    const familyId = world.floorExtendedState?.familyState?.presentFamilies.find(
      (candidate) => candidate === parsedFamilyId,
    );
    if (!familyId) {
      return null;
    }

    const objectiveViews = getQuestObjectiveViews(world, activeQuest, playerEid);
    const activeView =
      objectiveViews.find((view) => !view.complete && !view.hidden) ??
      objectiveViews.find((view) => !view.complete);
    if (!activeView) {
      const unlockedBoss = this.findNearestFloor2Boss(world, playerX, playerY, familyId);
      if (!unlockedBoss) return null;
      if (progressSuppressed && !this.isTargetReachable(world, playerX, playerY, unlockedBoss)) {
        return null;
      }
      return this.createFloor2BossProgressTarget(
        world,
        familyId,
        unlockedBoss,
        playerX,
        playerY,
        `Hunting the ${familyId} boss`,
      );
    }

    const objective = activeView.def;
    if (!this.updateFloor2HuntProgress(world, familyId)) {
      return null;
    }
    const territoryZone = this.getFloor2TerritoryZone(world, familyId);
    const playerInTerritory =
      territoryZone !== null &&
      this.isWorldPositionInFloor2TerritoryZone(world, territoryZone, playerX, playerY);
    const familyEnemy =
      playerInTerritory && territoryZone
        ? this.findNearestFloor2HuntEnemy(
            world,
            familyId,
            playerX,
            playerY,
            FLOOR2_HUNT_CHASE_RADIUS_FT,
            false,
          )
        : null;
    const territoryEnemy =
      playerInTerritory && territoryZone
        ? this.findNearestFloor2HuntEnemy(
            world,
            null,
            playerX,
            playerY,
            FLOOR2_HUNT_CHASE_RADIUS_FT,
            false,
            territoryZone,
          )
        : null;
    const bossTarget =
      this.findNearestFloor2Boss(world, playerX, playerY, familyId) ??
      this.findNearestFloor2Boss(
        world,
        playerX,
        playerY,
        familyId,
        Number.POSITIVE_INFINITY,
        false,
      );
    const territoryTarget = territoryZone
      ? this.resolveFloor2HuntPatrolTarget(world, familyId, territoryZone, playerX, playerY)
      : null;
    if (!progressSuppressed && territoryTarget && this.isFloor2HuntRecoveryWindow(world)) {
      return {
        ...territoryTarget,
        reason: `Patrolling the ${familyId} territory between engagements`,
      };
    }
    const territoryClearTarget = territoryEnemy
      ? this.createProgressTarget(
          territoryEnemy.x,
          territoryEnemy.y,
          playerX,
          playerY,
          `Clearing the ${familyId} territory while hunting den progress`,
          territoryEnemy.eid,
        )
      : null;

    switch (objective.kind) {
      case 'counter':
        if (familyEnemy) {
          return this.createProgressTarget(
            familyEnemy.x,
            familyEnemy.y,
            playerX,
            playerY,
            `Advancing ${familyId} den unlock (${activeView.current}/${activeView.target})`,
            familyEnemy.eid,
          );
        }
        return territoryClearTarget ?? (progressSuppressed ? null : territoryTarget);
      case 'collect':
        if (objective.itemId) {
          const itemTarget = this.findNearestQuestItem(world, objective.itemId, playerX, playerY);
          if (itemTarget) {
            return this.createProgressTarget(
              itemTarget.x,
              itemTarget.y,
              playerX,
              playerY,
              `Collecting ${activeView.def.label}`,
              itemTarget.eid,
            );
          }
        }
        if (familyEnemy) {
          return this.createProgressTarget(
            familyEnemy.x,
            familyEnemy.y,
            playerX,
            playerY,
            `Searching the ${familyId} territory for the unlock drop`,
            familyEnemy.eid,
          );
        }
        return territoryClearTarget ?? (progressSuppressed ? null : territoryTarget);
      case 'goal':
      case 'talk':
      case 'haveEquippable':
      case 'equip':
        if (bossTarget) {
          if (progressSuppressed && !this.isTargetReachable(world, playerX, playerY, bossTarget)) {
            // Fall through to familyEnemy / territoryClearTarget / territoryTarget.
          } else {
            return this.createFloor2BossProgressTarget(
              world,
              familyId,
              bossTarget,
              playerX,
              playerY,
              `Closing on the ${familyId} boss den`,
            );
          }
        }
        if (familyEnemy) {
          return this.createProgressTarget(
            familyEnemy.x,
            familyEnemy.y,
            playerX,
            playerY,
            `Working the ${familyId} den unlock`,
            familyEnemy.eid,
          );
        }
        return territoryClearTarget ?? (progressSuppressed ? null : territoryTarget);
      default:
        return null;
    }
  }

  /**
   * Nearest dropped Gold pile within {@link maxRadius} ft, ignoring loot we've
   * flagged unreachable. Unlike {@link findNearestLoot} this is gold-only and
   * uses a wider default radius: it backs the "farm gold for the merchant charm"
   * objective, where the AI must actively sweep up coins across a room rather
   * than only noticing gold that happens to fall within the default scanRadius.
   */
  private findNearestGold(
    world: GameWorld,
    playerX: number,
    playerY: number,
    maxRadius: number = this.config.scanRadius * 2,
  ): LootTarget | null {
    const golds = query(world.ecs, [Gold, Position]);
    const candidates: LootTarget[] = [];

    for (const eid of golds) {
      if (eid === undefined) continue;

      const ignoredUntil = this.ignoredLootUntilFrame.get(eid);
      if (ignoredUntil !== undefined) {
        if (ignoredUntil > world.frameCount) continue;
        this.ignoredLootUntilFrame.delete(eid);
      }

      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      const dist = Math.hypot(x - playerX, y - playerY);
      if (dist < maxRadius) {
        candidates.push({ eid, x, y, distance: dist, kind: 'gold' });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);

    // Nearest gold the player can actually reach. A coin pile sealed behind a
    // locked door must not anchor the "farm gold for the merchant charm" goal, or
    // the AI parks against the wall instead of sweeping reachable coins.
    for (const candidate of candidates) {
      if (this.isLootCollectable(world, playerX, playerY, candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Whether the player can A*-path to the given target (enemy or loot pile) from
   * its current position. Results are cached per target eid for a short window to
   * bound pathfinding cost, since this is consulted from multiple behavior-tree
   * conditions each frame. Door-aware passability treats a locked-unsatisfied
   * door (e.g. the boss door) as a wall, so a target sealed behind one reads as
   * unreachable until the lock is satisfied.
   */
  private isTargetReachable(
    world: GameWorld,
    playerX: number,
    playerY: number,
    target: WorldTarget,
  ): boolean {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return true;
    }

    const cached = this.targetReachableCache.get(target.eid);
    if (cached && world.frameCount - cached.frame < REACHABILITY_CACHE_TTL_FRAMES) {
      return cached.reachable;
    }

    const startTile = floorMap.worldToTile(playerX, playerY);
    const goalTile = floorMap.worldToTile(target.x, target.y);
    let reachable: boolean;
    if (startTile.x === goalTile.x && startTile.y === goalTile.y) {
      reachable = true;
    } else {
      // Match movement's goal resolution: a target whose exact tile is blocked
      // (standing against a wall) is still reachable via a nearby approach tile.
      const resolvedGoal = this.resolveReachableGoalTile(
        floorMap,
        startTile,
        goalTile,
        REACHABILITY_GOAL_SEARCH_RADIUS_TILES,
      );
      const path = findTilePath(floorMap, startTile, resolvedGoal, this.groundPathOptions());
      reachable = path.length > 1;
    }

    this.targetReachableCache.set(target.eid, { frame: world.frameCount, reachable });
    return reachable;
  }

  /**
   * Unlock-aware goal-graph resolution of the Floor 1 "middle chain" — the
   * shop errand (meet -> fetch -> return -> farm-gold -> buy -> equip) and
   * the spell-broker chain (accept -> Slime Rat -> claim), plus the
   * staircase boss, which the real door-lock config gates on BOTH chains
   * completing (verified against `floorScenario.ts`'s door-lock setup — see
   * `floor1-goal-graph.ts`'s module doc). Historically these were checked in
   * a fixed source order (fully resolve the shop errand, THEN attempt the
   * spell broker), which forced repeated west-hub/east-cluster round trips
   * whenever both chains had remaining work on opposite sides of the map.
   * Delegating ordering to the SAME declarative goal graph the run-planner
   * ETA uses (`buildFloor1GoalGraph` / `applyFloor1WorkCosts`), via the
   * strict, door-aware `floor1-travel-oracle.ts` oracle (real A* plus
   * hypothetical door-unlock effects — this is the runtime navigation
   * DECISION, not an ETA estimate, so it must NOT use the pure estimator's
   * straight-line fallback), lets the AI interleave same-neighborhood visits
   * instead.
   *
   * Returns `undefined` — NOT `null` — only when the planner does not own the
   * current phase (the floor map is not initialized yet, or the middle chain
   * is complete). Planner and graph errors intentionally propagate: silently
   * falling back to source-order logic would hide invalid or unreachable
   * objective graphs and reintroduce the route-ordering defect this planner
   * exists to remove. Returns the final, already detour-wrapped answer
   * (`ProgressTarget | null`) otherwise — `null` for goals with no navigable
   * target of their own (`equip-shop-charm`, or a boss fight already in
   * progress), matching the legacy behavior of returning `null` and letting
   * Engage/Hunt handle it.
   */
  private resolveFloor1MiddleChainObjective(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
    floorScenario: NonNullable<GameWorld['floorScenario']>,
    objective: NonNullable<GameWorld['floorScenario']>['objective'],
    shopStage: ReturnType<typeof getShopkeeperStage>,
    hasFetchItem: boolean,
    progressSuppressed: boolean,
    maybeDetourToQuestGiver: (target: ProgressTarget) => ProgressTarget,
  ): ProgressTarget | null | undefined {
    if (!world.floorMap) return undefined;

    const slimeRat = objective.bossBattles.get('slime-rat');
    const staircase = objective.bossBattles.get('staircase');
    if (!slimeRat || !staircase) return undefined;

    const snapshot: Floor1RunPlannerSnapshot = {
      nowMs: world.elapsedMs,
      deadlineMs: objective.deadlineMs,
      player: { x: playerX, y: playerY },
      currentTarget: null,
      activeQuestGiverDetour: false,
      tutorialAccepted: true,
      playerLevel: Math.max(2, world.playerLevel.level),
      questCompleted: true,
      ratsKilled: objective.requiredRats,
      slimesKilled: objective.requiredSlimes,
      requiredRats: objective.requiredRats,
      requiredSlimes: objective.requiredSlimes,
      requiredTotalKills: objective.requiredRats + objective.requiredSlimes,
      shopStage,
      playerGold: world.playerGold,
      shopkeeperEquipmentCost: SHOPKEEPER_EQUIPMENT_COST,
      hasShopFetchItem: hasFetchItem,
      bossBattleAccepted: world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID),
      slimeRatStarted: slimeRat.started,
      slimeRatDefeated: slimeRat.defeated,
      spellsUnlocked: world.featureUnlocks.spells,
      bossBattleComplete: world.goalFlags.get('floor1-boss-battle-complete') === true,
      staircaseStarted: staircase.started,
      staircaseDefeated: staircase.defeated,
      staircaseUnlocked: objective.staircaseUnlocked,
      staircaseDiscovered: objective.staircaseDiscovered,
      merchantWeaponIntent: (() => {
        const intent = getMerchantWeaponIntent(world);
        return intent.enabled && (intent.status === 'farming' || intent.status === 'returning')
          ? { status: intent.status, cost: intent.cost }
          : null;
      })(),
      positions: {
        welcomeOffice: objective.welcomeOfficePos,
        shop: objective.shopRoomPos,
        questItem: objective.questItemPos,
        spellQuestGiver: objective.spellQuestGiverPos,
        slimeRatRoom: objective.slimeRatRoomPos,
        staircase: objective.staircasePos,
      },
    };

    const stateKey = [
      snapshot.shopStage,
      snapshot.hasShopFetchItem,
      snapshot.playerGold,
      snapshot.bossBattleAccepted,
      snapshot.slimeRatStarted,
      snapshot.slimeRatDefeated,
      snapshot.spellsUnlocked,
      snapshot.bossBattleComplete,
      snapshot.staircaseStarted,
      snapshot.staircaseDefeated,
      snapshot.staircaseUnlocked,
      snapshot.staircaseDiscovered,
      snapshot.merchantWeaponIntent?.status ?? 'none',
      snapshot.merchantWeaponIntent?.cost ?? 0,
    ].join('|');
    const cache = this.floor1MiddleChainCache;

    let nextGoalId: string | null;
    if (cache?.navEpoch === this.navEpoch && cache.stateKey === stateKey) {
      nextGoalId = cache.goalId;
    } else {
      const rawGraph = buildFloor1GoalGraph(snapshot);
      if (rawGraph.goals.length === 0) return null;

      const playerSpeedFtPerFrame = this.getPlayerSpeedFtPerFrame(world, playerEid);
      const params = this.getRunPlannerParams(playerSpeedFtPerFrame);
      const graph = applyFloor1WorkCosts(rawGraph, snapshot, params);
      const oracle = makeFloor1DoorAwareTravelOracle(world, graph.locations, {
        moveSpeedFtPerMs: params.moveSpeedFtPerMs,
        pathOptions: this.groundPathOptions(),
      });

      const route = planObjectiveRoute({
        goals: graph.goals,
        startLocation: PLAYER_START_LOCATION,
        initialSatisfiedEffects: graph.initialSatisfiedEffects,
        budgetMs: Math.max(0, snapshot.deadlineMs - snapshot.nowMs - params.safetyBufferMs),
        travelOracle: oracle,
      });
      nextGoalId = route.nextActionableGoalId;
      this.floor1MiddleChainCache = {
        navEpoch: this.navEpoch,
        stateKey,
        goalId: nextGoalId,
      };
    }
    if (!nextGoalId) return null;

    switch (nextGoalId) {
      case 'meet-shopkeeper': {
        const reason = 'Seeking Shopkeeper to start the merchant errand';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'shop');
        return maybeDetourToQuestGiver(
          this.createNpcProgressTarget(
            world,
            playerX,
            playerY,
            floorScenario.shopkeeperNpcEid ?? -1,
            reason,
            objective.shopRoomPos.x,
            objective.shopRoomPos.y,
            AINpcInteractionAction.MEET_SHOPKEEPER,
          ),
        );
      }
      case 'fetch-shop-prize': {
        const reason = 'Seeking the merchant fetch item';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'shop');
        return maybeDetourToQuestGiver(
          this.createProgressTarget(
            objective.questItemPos.x,
            objective.questItemPos.y,
            playerX,
            playerY,
            reason,
          ),
        );
      }
      case 'return-shop-prize': {
        const reason = 'Returning the merchant prize';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'shop');
        return maybeDetourToQuestGiver(
          this.createNpcProgressTarget(
            world,
            playerX,
            playerY,
            floorScenario.shopkeeperNpcEid ?? -1,
            reason,
            objective.shopRoomPos.x,
            objective.shopRoomPos.y,
            AINpcInteractionAction.RETURN_SHOPKEEPER_PRIZE,
          ),
        );
      }
      case 'farm-shop-gold': {
        const goldOwed = Math.max(0, SHOPKEEPER_EQUIPMENT_COST - world.playerGold);
        const target = this.findMerchantGoldFarmTarget(
          world,
          playerX,
          playerY,
          goldOwed,
          'merchant charm',
        );
        return target ? maybeDetourToQuestGiver(target) : null;
      }
      case 'buy-shop-charm': {
        const reason = 'Returning to the Shopkeeper to buy the charm';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'shop');
        return maybeDetourToQuestGiver(
          this.createNpcProgressTarget(
            world,
            playerX,
            playerY,
            floorScenario.shopkeeperNpcEid ?? -1,
            reason,
            objective.shopRoomPos.x,
            objective.shopRoomPos.y,
            AINpcInteractionAction.BUY_SHOPKEEPER_EQUIPMENT,
          ),
        );
      }
      case 'equip-shop-charm':
        // Handled ambiently/automatically — no legacy branch existed for
        // this transient stage either (the shop-stage switch had no
        // 'awaiting-equip' case), so Progress correctly has nothing to say.
        return null;
      case 'farm-merchant-weapon-gold': {
        const intent = getMerchantWeaponIntent(world);
        const goldOwed = Math.max(0, intent.cost - world.playerGold);
        const target = this.findMerchantGoldFarmTarget(
          world,
          playerX,
          playerY,
          goldOwed,
          'merchant weapon',
        );
        return target ? maybeDetourToQuestGiver(target) : null;
      }
      case 'buy-merchant-weapon': {
        const reason = 'Returning to the Shopkeeper to buy the selected weapon';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'shop');
        return maybeDetourToQuestGiver(
          this.createProgressTarget(
            objective.shopRoomPos.x,
            objective.shopRoomPos.y,
            playerX,
            playerY,
            reason,
            floorScenario.shopkeeperNpcEid ?? -1,
          ),
        );
      }
      case 'accept-spell-quest': {
        const reason = 'Seeking the Spell Broker to start the Slime Rat quest';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'spell-broker');
        return maybeDetourToQuestGiver(
          this.createNpcProgressTarget(
            world,
            playerX,
            playerY,
            floorScenario.spellQuestGiverNpcEid ?? -1,
            reason,
            objective.spellQuestGiverPos.x,
            objective.spellQuestGiverPos.y,
            AINpcInteractionAction.ACCEPT_SPELL_QUEST,
          ),
        );
      }
      case 'kill-slime-rat': {
        const reason = 'Heading to the Slime Rat room';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'spell-broker');
        return maybeDetourToQuestGiver(
          this.createProgressTarget(
            objective.slimeRatRoomPos.x,
            objective.slimeRatRoomPos.y,
            playerX,
            playerY,
            reason,
          ),
        );
      }
      case 'finish-slime-rat':
        // Active battle — let Engage/Hunt fight it, exactly like legacy.
        return null;
      case 'claim-spell-reward': {
        const reason = 'Returning to the Spell Broker to claim a spell reward';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'spell-broker');
        return maybeDetourToQuestGiver(
          this.createNpcProgressTarget(
            world,
            playerX,
            playerY,
            floorScenario.spellQuestGiverNpcEid ?? -1,
            reason,
            objective.spellQuestGiverPos.x,
            objective.spellQuestGiverPos.y,
            AINpcInteractionAction.CLAIM_SPELL_REWARD,
          ),
        );
      }
      case 'kill-staircase-boss': {
        const reason = 'Heading to the staircase boss room';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'staircase');
        return maybeDetourToQuestGiver(
          this.createProgressTarget(
            objective.staircasePos.x,
            objective.staircasePos.y,
            playerX,
            playerY,
            reason,
          ),
        );
      }
      case 'finish-staircase-boss':
        // Active battle — let Engage/Hunt fight it, exactly like legacy.
        return null;
      case 'take-stairs': {
        const reason = 'Heading to the stairs to clear the floor';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'post-stairs');
        return maybeDetourToQuestGiver(
          this.createProgressTarget(
            objective.staircasePos.x,
            objective.staircasePos.y,
            playerX,
            playerY,
            reason,
          ),
        );
      }
      default:
        throw new Error(`Unsupported Floor 1 objective planner goal "${nextGoalId}".`);
    }
  }

  private findProgressObjective(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
  ): ProgressTarget | null {
    const panicProfile = this.getCollapsePanicProfile(world);
    const maybeDetourToQuestGiver = (target: ProgressTarget): ProgressTarget =>
      this.withQuestGiverDetour(world, playerEid, playerX, playerY, target, panicProfile);
    const floorScenario = world.floorScenario;
    if (world.floorExtendedState?.familyState) {
      const floor2Target = this.findFloor2ProgressObjective(world, playerEid, playerX, playerY);
      if (floor2Target) {
        return this.isFloor2IntroductionPending(world)
          ? floor2Target
          : maybeDetourToQuestGiver(floor2Target);
      }
    }
    const objective = floorScenario?.objective;
    if (!floorScenario || !objective) {
      return null;
    }

    const shopStage = getShopkeeperStage(world);
    const bag = world.inventories.get(playerEid);
    const hasFetchItem = bag ? hasItem(bag, SHOPKEEPER_FETCH_ITEM_ID) : false;
    const tutorialAccepted = world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID);
    const bossBattleAccepted = world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID);
    // True while the dwell-watchdog has flagged all position-based progress goals
    // as temporarily unreachable. Entity-based goals (quest enemies, gold piles) are
    // NOT affected — only fixed-position NPC/room targets get suppressed.
    const progressSuppressed = world.frameCount < this.progressGoalSuppressedUntilFrame;

    if (!tutorialAccepted) {
      const tutorialGoonEid = floorScenario.guideNpcEid ?? -1;
      const reason = 'Seeking Tutorial Goon to unlock the floor quest';
      if (progressSuppressed) {
        const nearestEnemy = this.findNearestEnemy(world, playerX, playerY);
        if (nearestEnemy) {
          return maybeDetourToQuestGiver(
            this.createProgressTarget(
              nearestEnemy.x,
              nearestEnemy.y,
              playerX,
              playerY,
              'Clearing threats while reacquiring Tutorial Goon',
              nearestEnemy.eid,
            ),
          );
        }
        return this.recordSuppressedProgressNavigation(world, reason, 'pre-chain');
      }
      return maybeDetourToQuestGiver(
        this.createNpcProgressTarget(
          world,
          playerX,
          playerY,
          tutorialGoonEid,
          reason,
          objective.welcomeOfficePos.x,
          objective.welcomeOfficePos.y,
          AINpcInteractionAction.ACCEPT_TUTORIAL_QUEST,
        ),
      );
    }

    if (world.playerLevel.level < 2) {
      // Tutorial level-grind: reaching level 2 is driven by the ambient swarm
      // that is always on the player (handled by Engage/Hunt), so no explicit
      // Progress objective is needed here.
      return null;
    }

    if (!objective.questCompleted) {
      // Boss-unlock kill-grind: the quest needs 6 rats + 4 slimes, and a kill
      // only counts when an ambient-swarm enemy tracked in enemyArchetypes dies
      // in combat (out-of-range despawns are pruned without counting). Engage
      // only fires within a small radius, so once the swarm drifts past it the AI
      // would otherwise frontier-Explore *away* from the very enemies it must
      // kill (seed 2 wandered ~285s without a single kill). Route Progress —
      // which outranks Engage/Explore — to the nearest living, reachable quest
      // enemy with an unbounded radius so the AI commits to hunting the swarm. If
      // none is currently reachable, fall through to Explore to uncover more of
      // the map (and open doors) toward them.
      const questEnemy = this.findNearestQuestEnemy(world, playerX, playerY);
      if (questEnemy) {
        const ratsLeft = Math.max(0, objective.requiredRats - objective.ratsKilled);
        const slimesLeft = Math.max(0, objective.requiredSlimes - objective.slimesKilled);
        return maybeDetourToQuestGiver(
          this.createProgressTarget(
            questEnemy.x,
            questEnemy.y,
            playerX,
            playerY,
            `Hunting quest enemies (${ratsLeft} rats, ${slimesLeft} slimes to go)`,
            questEnemy.eid,
          ),
        );
      }
      return null;
    }

    // Let the unlock-aware goal-graph planner own the shop/spell/final-boss
    // middle chain. The legacy code below remains responsible only for phases
    // outside that graph (startup before a floor map exists, and post-chain
    // stair interaction).
    const middleChainTarget = this.resolveFloor1MiddleChainObjective(
      world,
      playerEid,
      playerX,
      playerY,
      floorScenario,
      objective,
      shopStage,
      hasFetchItem,
      progressSuppressed,
      maybeDetourToQuestGiver,
    );
    if (middleChainTarget !== undefined) {
      return middleChainTarget;
    }

    if (shopStage === 'not-met') {
      const reason = 'Seeking Shopkeeper to start the merchant errand';
      if (progressSuppressed) return this.recordSuppressedProgressNavigation(world, reason, 'shop');
      return maybeDetourToQuestGiver(
        this.createNpcProgressTarget(
          world,
          playerX,
          playerY,
          floorScenario.shopkeeperNpcEid ?? -1,
          reason,
          objective.shopRoomPos.x,
          objective.shopRoomPos.y,
          AINpcInteractionAction.MEET_SHOPKEEPER,
        ),
      );
    }

    if (shopStage === 'awaiting-prize') {
      const target = hasFetchItem ? objective.shopRoomPos : objective.questItemPos;
      const reason = hasFetchItem
        ? 'Returning the merchant prize'
        : 'Seeking the merchant fetch item';
      if (progressSuppressed) return this.recordSuppressedProgressNavigation(world, reason, 'shop');
      return maybeDetourToQuestGiver(
        hasFetchItem
          ? this.createNpcProgressTarget(
              world,
              playerX,
              playerY,
              floorScenario.shopkeeperNpcEid ?? -1,
              reason,
              target.x,
              target.y,
              AINpcInteractionAction.RETURN_SHOPKEEPER_PRIZE,
            )
          : this.createProgressTarget(target.x, target.y, playerX, playerY, reason),
      );
    }

    if (shopStage === 'ready-to-buy') {
      if (world.playerGold >= SHOPKEEPER_EQUIPMENT_COST) {
        const reason = 'Returning to the Shopkeeper to buy the charm';
        if (progressSuppressed)
          return this.recordSuppressedProgressNavigation(world, reason, 'shop');
        return maybeDetourToQuestGiver(
          this.createNpcProgressTarget(
            world,
            playerX,
            playerY,
            floorScenario.shopkeeperNpcEid ?? -1,
            reason,
            objective.shopRoomPos.x,
            objective.shopRoomPos.y,
            AINpcInteractionAction.BUY_SHOPKEEPER_EQUIPMENT,
          ),
        );
      }

      // Still short on gold: actively farm the ambient swarm rather than wander.
      // The merchant errand cannot complete until the charm is bought, and the
      // charm needs gold that only drops from kills. Prefer sweeping up coins
      // that have already dropped (walking onto a pile collects it), otherwise
      // close on the nearest enemy so auto-fire generates more drops. Routing
      // this through Progress (which outranks Engage/Collect) is what makes the
      // AI commit to gold instead of treating distant enemies as "nothing to do"
      // and exploring away from them.
      const goldOwed = SHOPKEEPER_EQUIPMENT_COST - world.playerGold;
      const target = this.findMerchantGoldFarmTarget(
        world,
        playerX,
        playerY,
        goldOwed,
        'merchant charm',
      );
      return target ? maybeDetourToQuestGiver(target) : null;
    }

    const merchantWeaponIntent = getMerchantWeaponIntent(world);
    if (
      shopStage === 'complete' &&
      merchantWeaponIntent.enabled &&
      merchantWeaponIntent.status === 'farming'
    ) {
      const goldOwed = Math.max(0, merchantWeaponIntent.cost - world.playerGold);
      const target = this.findMerchantGoldFarmTarget(
        world,
        playerX,
        playerY,
        goldOwed,
        'merchant weapon',
      );
      return target ? maybeDetourToQuestGiver(target) : null;
    }
    if (
      shopStage === 'complete' &&
      merchantWeaponIntent.enabled &&
      merchantWeaponIntent.status === 'returning'
    ) {
      const reason = 'Returning to the Shopkeeper to buy the selected weapon';
      if (progressSuppressed) return this.recordSuppressedProgressNavigation(world, reason, 'shop');
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.shopRoomPos.x,
          objective.shopRoomPos.y,
          playerX,
          playerY,
          reason,
          floorScenario.shopkeeperNpcEid ?? -1,
        ),
      );
    }

    if (!objective.questCompleted) {
      return null;
    }

    if (!bossBattleAccepted) {
      const reason = 'Seeking the Spell Broker to start the Slime Rat quest';
      if (progressSuppressed)
        return this.recordSuppressedProgressNavigation(world, reason, 'spell-broker');
      return maybeDetourToQuestGiver(
        this.createNpcProgressTarget(
          world,
          playerX,
          playerY,
          floorScenario.spellQuestGiverNpcEid ?? -1,
          reason,
          objective.spellQuestGiverPos.x,
          objective.spellQuestGiverPos.y,
          AINpcInteractionAction.ACCEPT_SPELL_QUEST,
        ),
      );
    }

    if (!objective.bossBattles.get('slime-rat')!.started) {
      const reason = 'Heading to the Slime Rat room';
      if (progressSuppressed)
        return this.recordSuppressedProgressNavigation(world, reason, 'spell-broker');
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.slimeRatRoomPos.x,
          objective.slimeRatRoomPos.y,
          playerX,
          playerY,
          reason,
        ),
      );
    }

    if (objective.bossBattles.get('slime-rat')!.defeated && !world.featureUnlocks.spells) {
      const reason = 'Returning to the Spell Broker to claim a spell reward';
      if (progressSuppressed)
        return this.recordSuppressedProgressNavigation(world, reason, 'spell-broker');
      return maybeDetourToQuestGiver(
        this.createNpcProgressTarget(
          world,
          playerX,
          playerY,
          floorScenario.spellQuestGiverNpcEid ?? -1,
          reason,
          objective.spellQuestGiverPos.x,
          objective.spellQuestGiverPos.y,
          AINpcInteractionAction.CLAIM_SPELL_REWARD,
        ),
      );
    }

    if (
      objective.bossBattles.get('slime-rat')!.defeated &&
      !objective.bossBattles.get('staircase')!.started
    ) {
      const reason = 'Heading to the staircase boss room';
      if (progressSuppressed)
        return this.recordSuppressedProgressNavigation(world, reason, 'staircase');
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.staircasePos.x,
          objective.staircasePos.y,
          playerX,
          playerY,
          reason,
        ),
      );
    }

    if (objective.staircaseUnlocked && !objective.staircaseDiscovered) {
      const reason = 'Heading to the stairs to clear the floor';
      // F2 (SLACK_AWARE exit-commitment tail) — NARROWED after plan review.
      // The original design forced the staircase Progress target under urgency by
      // BYPASSING `progressGoalSuppressed`. Review flagged that as a monotonicity
      // hazard: the quest-progress dwell watchdog sets that suppression window
      // precisely to unstick a wedge (swarm pinning the player against an
      // unreachable fixed goal) by letting Hunt/Explore relocate. Bypassing it
      // while F1 simultaneously suppresses Collect/Hunt/Explore could livelock the
      // agent on a wedged target and flip a previously-winning run into a loss.
      // So F2's suppression override is DROPPED — the exit-commitment is delivered
      // entirely by F1 (optional-goal suppression makes the agent commit to
      // whatever Progress returns, which in this final leg is the staircase when
      // not suppressed). This honors the legacy wedge-recovery escape hatch and is
      // strictly more conservative, guaranteeing monotonicity. No-op in LEGACY.
      if (progressSuppressed)
        return this.recordSuppressedProgressNavigation(world, reason, 'post-stairs');
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.staircasePos.x,
          objective.staircasePos.y,
          playerX,
          playerY,
          reason,
        ),
      );
    }

    return null;
  }

  private findMerchantGoldFarmTarget(
    world: GameWorld,
    playerX: number,
    playerY: number,
    goldOwed: number,
    purchaseLabel: string,
  ): ProgressTarget | null {
    const goldPile = this.findNearestGold(world, playerX, playerY, GOLD_FARM_GOLD_SCAN_RADIUS_FT);
    if (goldPile && goldPile.distance <= GOLD_FARM_COLLECT_RADIUS_FT) {
      return this.createProgressTarget(
        goldPile.x,
        goldPile.y,
        playerX,
        playerY,
        `Collecting gold for the ${purchaseLabel} (${goldOwed}g to go)`,
        goldPile.eid,
      );
    }
    const prey = this.findNearestEnemy(world, playerX, playerY, GOLD_FARM_ENEMY_SCAN_RADIUS_FT);
    if (prey) {
      return this.createProgressTarget(
        prey.x,
        prey.y,
        playerX,
        playerY,
        `Hunting the swarm for ${purchaseLabel} gold (${goldOwed}g to go)`,
        prey.eid,
      );
    }
    if (goldPile) {
      return this.createProgressTarget(
        goldPile.x,
        goldPile.y,
        playerX,
        playerY,
        `Collecting gold for the ${purchaseLabel} (${goldOwed}g to go)`,
        goldPile.eid,
      );
    }
    return null;
  }

  private recordSuppressedProgressNavigation(
    world: GameWorld,
    blockedTargetReason: string,
    criticalChainPhase: RunPlanSegmentPhase,
  ): null {
    this.pendingSuppressedProgressNavDebug = {
      state: AIDecisionDebugState.SUPPRESSED_PROGRESS_NAV,
      reason: 'progressGoalSuppressed',
      source:
        this.progressGoalSuppressionSource ??
        AIProgressSuppressionSource.PROGRESS_GOAL_SUPPRESSION_WINDOW,
      criticalChainPhase,
      blockedTargetReason,
      suppressedUntilFrame: this.progressGoalSuppressedUntilFrame,
      remainingFrames: Math.max(0, this.progressGoalSuppressedUntilFrame - world.frameCount),
    };
    return null;
  }

  private createProgressTarget(
    x: number,
    y: number,
    playerX: number,
    playerY: number,
    reason: string,
    eid: number = -1,
  ): ProgressTarget {
    return {
      eid,
      x,
      y,
      distance: Math.hypot(x - playerX, y - playerY),
      reason,
      npcInteraction: null,
    };
  }

  private createFloor2BossProgressTarget(
    world: GameWorld,
    familyId: FamilyId,
    boss: WorldTarget,
    playerX: number,
    playerY: number,
    reason: string,
  ): ProgressTarget {
    const encounterStarted =
      world.floorExtendedState?.familyState?.bossEncounters?.get(familyId)?.started === true;
    return this.createProgressTarget(
      boss.x,
      boss.y,
      playerX,
      playerY,
      reason,
      encounterStarted ? boss.eid : -1,
    );
  }

  private createNpcProgressTarget(
    world: GameWorld,
    playerX: number,
    playerY: number,
    npcEid: number,
    reason: string,
    fallbackX: number,
    fallbackY: number,
    interactionAction: AINpcInteractionActionValue,
  ): ProgressTarget {
    const hasLiveNpc =
      npcEid >= 0 && entityExists(world.ecs, npcEid) && hasComponent(world.ecs, npcEid, Npc);
    if (!hasLiveNpc) {
      return this.createProgressTarget(fallbackX, fallbackY, playerX, playerY, reason, -1);
    }

    const npcX = world.stores.position.x[npcEid];
    const npcY = world.stores.position.y[npcEid];
    if (npcX === undefined || npcY === undefined) {
      return this.createProgressTarget(fallbackX, fallbackY, playerX, playerY, reason, -1);
    }

    const approach = this.resolveNpcInteractionAnchor(world, playerX, playerY, npcX, npcY, npcEid);
    return {
      eid: npcEid,
      x: approach.x,
      y: approach.y,
      distance: Math.hypot(approach.x - playerX, approach.y - playerY),
      reason,
      npcInteraction: {
        npcEid,
        action: interactionAction,
        allowWhileExploring: true,
      },
    };
  }

  private resolveNpcInteractionAnchor(
    world: GameWorld,
    playerX: number,
    playerY: number,
    npcX: number,
    npcY: number,
    npcEid: number,
  ): { x: number; y: number } {
    // Serve cached result when available — the anchor is a pure function of
    // (floorMap, npcTile, passability graph) and is stable for the floor lifetime.
    if (this.npcInteractionAnchorCache.has(npcEid)) {
      const cached = this.npcInteractionAnchorCache.get(npcEid)!;
      return cached ?? { x: npcX, y: npcY };
    }

    const floorMap = world.floorMap;
    if (!floorMap) {
      return { x: npcX, y: npcY };
    }

    // If we're already within the real interaction range, target the NPC directly,
    // but do not cache that player-relative fast path for future revisits.
    if (Math.hypot(npcX - playerX, npcY - playerY) <= NPC_INTERACTION_RADIUS_FT) {
      return { x: npcX, y: npcY };
    }

    const startTile = floorMap.worldToTile(playerX, playerY);
    const npcTile = floorMap.worldToTile(npcX, npcY);
    // Search a bounded neighborhood around the NPC tile for the nearest
    // reachable approach tile (by world distance to NPC), then treat that tile
    // center as the interaction anchor.
    const searchRadiusTiles = 40;
    const tileMap = floorMap.tileMap;
    const width = tileMap.width;
    const height = tileMap.height;
    const passable =
      this.doorAwarePassable ?? ((tx: number, ty: number): boolean => tileMap.isPassable(tx, ty));

    if (!tileMap.inBounds(startTile.x, startTile.y) || !passable(startTile.x, startTile.y)) {
      return { x: npcX, y: npcY };
    }

    const dist = new Int32Array(width * height).fill(-1);
    const queue = new Int32Array(width * height);
    const startIndex = startTile.y * width + startTile.x;
    floodReachabilityDepth(
      dist,
      queue,
      width,
      height,
      startIndex,
      NAVIGATION_MAX_PATH_LENGTH - 1,
      passable,
    );

    let bestTile: TilePoint | null = null;
    let bestNpcDistance = Number.POSITIVE_INFINITY;
    let bestPathDepth = Number.POSITIVE_INFINITY;
    for (let dy = -searchRadiusTiles; dy <= searchRadiusTiles; dy++) {
      for (let dx = -searchRadiusTiles; dx <= searchRadiusTiles; dx++) {
        const tx = npcTile.x + dx;
        const ty = npcTile.y + dy;
        if (!tileMap.inBounds(tx, ty) || !passable(tx, ty)) {
          continue;
        }
        const depth = dist[ty * width + tx]!;
        if (depth < 1) {
          continue;
        }
        const worldPos = floorMap.tileToWorld(tx, ty);
        const npcDistance = Math.hypot(worldPos.x - npcX, worldPos.y - npcY);
        if (
          npcDistance < bestNpcDistance ||
          (npcDistance === bestNpcDistance && depth < bestPathDepth)
        ) {
          bestTile = { x: tx, y: ty };
          bestNpcDistance = npcDistance;
          bestPathDepth = depth;
        }
      }
    }

    if (!bestTile) {
      // No reachable tile within the search radius — cache null so we don't retry
      // BFS every frame, then fall back to raw NPC position. The watchdog will
      // eventually suppress this goal and route via enemies instead.
      console.warn(
        `[BT] resolveNpcInteractionAnchor: no reachable tile within ${searchRadiusTiles} tiles ` +
          `of NPC eid=${npcEid} at (${npcX.toFixed(1)}, ${npcY.toFixed(1)}). ` +
          `Falling back to raw NPC position — progression may stall.`,
      );
      this.npcInteractionAnchorCache.set(npcEid, null);
      return { x: npcX, y: npcY };
    }
    const result = floorMap.tileToWorld(bestTile.x, bestTile.y);
    this.npcInteractionAnchorCache.set(npcEid, result);
    return result;
  }

  /**
   * Project a combat-flavored Progress objective onto a {@link WorldTarget} at
   * the enemy's current position so it can be routed through the shared
   * {@link planEngagement} kite logic. Returns null for position objectives
   * (eid < 0), dead/despawned entities, and non-enemy entities such as gold
   * piles — those should be approached directly, not kited.
   */
  private progressTargetAsEnemy(
    world: GameWorld,
    target: ProgressTarget,
    playerX: number,
    playerY: number,
  ): WorldTarget | null {
    if (target.eid < 0 || !entityExists(world.ecs, target.eid)) {
      return null;
    }
    if (!hasComponent(world.ecs, target.eid, Enemy)) {
      return null;
    }
    const ex = world.stores.position.x[target.eid];
    const ey = world.stores.position.y[target.eid];
    if (ex === undefined || ey === undefined) {
      return null;
    }
    return {
      eid: target.eid,
      x: ex,
      y: ey,
      distance: Math.hypot(ex - playerX, ey - playerY),
    };
  }

  private getEngageRadius(world: GameWorld): number {
    const weapon = getActiveWeapon(world);
    if (!weapon) {
      return this.config.scanRadius * 0.4;
    }

    const reachFt = Math.max(weapon.range, weapon.aoeRadius);
    if (weapon.weaponType === WeaponType.MELEE) {
      return Math.max(reachFt * 4, 20);
    }

    return Math.min(this.config.scanRadius, Math.max(reachFt, this.config.rangedSafeDistance * 2));
  }

  private findNearestLoot(world: GameWorld, playerX: number, playerY: number): LootTarget | null {
    const stickyLoot = this.resolveStickyLootTarget(world, playerX, playerY);
    if (stickyLoot && this.isLootCollectable(world, playerX, playerY, stickyLoot)) {
      return stickyLoot;
    }

    const candidates: LootTarget[] = [];
    const maxDist = this.config.scanRadius;

    const sources: Array<{ kind: LootKind; entities: ReturnType<typeof query> }> = [
      { kind: 'xp', entities: query(world.ecs, [XpGem, Position]) },
      { kind: 'gold', entities: query(world.ecs, [Gold, Position]) },
      { kind: 'item', entities: query(world.ecs, [DroppedItem, Position]) },
      { kind: 'harvest', entities: query(world.ecs, [Harvestable, Position]) },
    ];

    for (const source of sources) {
      for (const eid of source.entities) {
        if (eid === undefined) continue;
        const ignoredUntil = this.ignoredLootUntilFrame.get(eid);
        if (ignoredUntil !== undefined && ignoredUntil > world.frameCount) {
          continue;
        }
        if (ignoredUntil !== undefined && ignoredUntil <= world.frameCount) {
          this.ignoredLootUntilFrame.delete(eid);
        }

        const x = world.stores.position.x[eid] ?? 0;
        const y = world.stores.position.y[eid] ?? 0;
        const dist = Math.hypot(x - playerX, y - playerY);
        if (dist < maxDist) {
          candidates.push({ eid, x, y, distance: dist, kind: source.kind });
        }
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);

    // Return the nearest loot we can actually path to. Skipping unreachable loot
    // — e.g. a pile that fell outside the room, behind the still-locked boss door
    // — lets the tree fall through to Engage/Explore instead of committing COLLECT
    // to a goal the player can only reach once the door unlocks. Without this the
    // AI wedges against the wall until the dwell watchdog abandons it ~180f later;
    // a totally unreachable item never becomes a goal in the first place. Mirrors
    // findNearestEnemy's reachability filtering (door-aware A*, cached per eid).
    for (const candidate of candidates) {
      if (this.isLootCollectable(world, playerX, playerY, candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * A loot pile is collectable when it sits essentially under the player (within
   * {@link DIRECT_MOVE_EPSILON_FT}, so a direct step closes it and no A* is
   * needed) or the player can A*-path to it. The reachability test is door-aware,
   * so loot sealed behind a locked-unsatisfied door reads as uncollectable until
   * the lock opens — the moment it does, the same pile becomes a valid goal again.
   */
  private isLootCollectable(
    world: GameWorld,
    playerX: number,
    playerY: number,
    loot: LootTarget,
  ): boolean {
    if (loot.distance <= DIRECT_MOVE_EPSILON_FT) {
      return true;
    }
    return this.isTargetReachable(world, playerX, playerY, loot);
  }

  private resolveStickyLootTarget(
    world: GameWorld,
    playerX: number,
    playerY: number,
  ): LootTarget | null {
    const stickyEid = this.decision.targetEid;
    if (this.decision.state !== AIState.COLLECT || stickyEid === null || stickyEid === undefined) {
      return null;
    }

    const ignoredUntil = this.ignoredLootUntilFrame.get(stickyEid);
    if (ignoredUntil !== undefined && ignoredUntil > world.frameCount) {
      return null;
    }
    if (ignoredUntil !== undefined && ignoredUntil <= world.frameCount) {
      this.ignoredLootUntilFrame.delete(stickyEid);
    }

    if (!hasComponent(world.ecs, stickyEid, Position)) {
      return null;
    }

    const isXp = hasComponent(world.ecs, stickyEid, XpGem);
    const isGold = hasComponent(world.ecs, stickyEid, Gold);
    const isItem = hasComponent(world.ecs, stickyEid, DroppedItem);
    const isHarvest = hasComponent(world.ecs, stickyEid, Harvestable);
    if (!isXp && !isGold && !isItem && !isHarvest) {
      return null;
    }

    const x = world.stores.position.x[stickyEid];
    const y = world.stores.position.y[stickyEid];
    if (typeof x !== 'number' || typeof y !== 'number') {
      return null;
    }

    const distance = Math.hypot(x - playerX, y - playerY);
    if (distance > this.config.scanRadius * 1.25) {
      return null;
    }
    return {
      eid: stickyEid,
      x,
      y,
      distance,
      kind: isXp ? 'xp' : isGold ? 'gold' : isItem ? 'item' : 'harvest',
    };
  }

  /**
   * Enemy/NPC perception rule: only entities in current FOV or on minimap-known
   * tiles are considered known. Before perception initializes (e.g. isolated unit
   * tests without an FOV step), fall back to permissive behavior.
   */
  private canPerceiveWorldPosition(world: GameWorld, x: number, y: number): boolean {
    const floorMap = world.floorMap;
    if (!floorMap) return true;
    const tile = floorMap.worldToTile(x, y);
    if (tile.x < 0 || tile.y < 0 || tile.x >= floorMap.width || tile.y >= floorMap.height) {
      return false;
    }
    if (!this.hasPerceptionData) return true;
    if (floorMap.isVisible(tile.x, tile.y)) return true;
    return floorMap.isDiscovered(tile.x, tile.y);
  }

  /**
   * Stricter sibling of {@link canPerceiveWorldPosition}: matches the render
   * cue's exact visibility gate (PhaserBridge only draws the telegraph cue
   * when the shooter's current tile is in LIVE FOV — not merely
   * discovered/remembered). Used solely for the telegraphed-shot dodge gate
   * so the AI cannot react to a threat the player cannot currently see
   * rendered. Falls back to permissive (true) with no floorMap/perception
   * data yet, matching canPerceiveWorldPosition's isolated-unit-test fallback.
   */
  private canCurrentlyPerceiveWorldPosition(world: GameWorld, x: number, y: number): boolean {
    const floorMap = world.floorMap;
    if (!floorMap || !this.hasPerceptionData) return true;
    const tile = floorMap.worldToTile(x, y);
    return floorMap.isVisible(tile.x, tile.y);
  }

  /**
   * Breadth-first search outward from the player through SEEN, reachable ground
   * for the nearest frontier — a seen, door-aware-passable tile that borders an
   * unseen tile. Walking to a frontier (often a doorway into an unentered room)
   * and stepping onto it reveals the unseen neighbours via FOV, the frontier
   * recedes, and the next BFS picks the new nearest edge: a systematic outward
   * sweep that surfaces objective rooms (and their NPCs) far sooner than random
   * sampling.
   *
   * Only frontiers beyond {@link EXPLORE_FRONTIER_MIN_FT} are returned so every
   * target forces real travel — which always changes the fog, so the frontier set
   * always changes and the AI can never lock onto a zero-movement target. Returns
   * `null` when no qualifying frontier remains (near-complete exploration), so the
   * caller can fall back to the random far-tile sampler.
   */
  private findNearestFrontier(
    world: GameWorld,
    playerX: number,
    playerY: number,
  ): { x: number; y: number } | null {
    const floorMap = world.floorMap;
    if (!floorMap || !this.hasPerceptionData) {
      return null;
    }

    const tileMap = floorMap.tileMap;
    const width = floorMap.width;
    const height = floorMap.height;
    const passable =
      this.doorAwarePassable ?? ((tx: number, ty: number): boolean => tileMap.isPassable(tx, ty));

    const start = floorMap.worldToTile(playerX, playerY);
    if (tileMap.index(start.x, start.y) === -1) {
      return null;
    }

    if (!this.frontierBfsVisited || this.frontierBfsVisited.length !== width * height) {
      this.frontierBfsVisited = new Uint8Array(width * height);
    }

    const grid: FrontierGrid = {
      width,
      height,
      index: (tx, ty) => tileMap.index(tx, ty),
      isSeen: (idx) => floorMap.isDiscoveredIndex(idx),
      isPassable: (tx, ty) => passable(tx, ty),
      tileDistanceFt: (tx, ty) => {
        const wp = floorMap.tileToWorld(tx, ty);
        return Math.hypot(wp.x - playerX, wp.y - playerY);
      },
    };

    const frontier = findNearestFrontierTile(
      grid,
      start.x,
      start.y,
      EXPLORE_FRONTIER_MIN_FT,
      EXPLORE_FRONTIER_BFS_MAX_TILES,
      this.frontierBfsVisited,
    );
    if (!frontier) {
      return null;
    }
    const wp = floorMap.tileToWorld(frontier.tileX, frontier.tileY);
    return { x: wp.x, y: wp.y };
  }

  private computeExploreReachabilityDepth(
    floorMap: FloorMap,
    startTile: TilePoint,
    passable: (tx: number, ty: number) => boolean,
  ): Int32Array {
    const width = floorMap.width;
    const height = floorMap.height;
    const tileCount = width * height;
    if (!this.exploreReachabilityDepth || this.exploreReachabilityDepth.length !== tileCount) {
      this.exploreReachabilityDepth = new Int32Array(tileCount);
    }
    if (!this.exploreReachabilityQueue || this.exploreReachabilityQueue.length !== tileCount) {
      this.exploreReachabilityQueue = new Int32Array(tileCount);
    }
    const depth = this.exploreReachabilityDepth;
    const queue = this.exploreReachabilityQueue;
    depth.fill(-1);

    const startIndex = floorMap.tileMap.index(startTile.x, startTile.y);
    if (startIndex === -1 || !passable(startTile.x, startTile.y)) {
      return depth;
    }

    const maxDepth = NAVIGATION_MAX_PATH_LENGTH - 1;
    floodReachabilityDepth(depth, queue, width, height, startIndex, maxDepth, passable);

    return depth;
  }

  private pickExploreTarget(
    world: GameWorld,
    playerX: number,
    playerY: number,
  ): { x: number; y: number } {
    const floorMap = world.floorMap;
    if (!floorMap) {
      const angle = this.rng.next() * Math.PI * 2;
      const distance = 25 + this.rng.next() * 25;
      return {
        x: playerX + Math.cos(angle) * distance,
        y: playerY + Math.sin(angle) * distance,
      };
    }

    const startTile = floorMap.worldToTile(playerX, playerY);

    // Prefer the nearest fog-of-war frontier: this sweeps the map outward through
    // known-passable ground and reveals unentered rooms (and their NPCs/doors) far
    // sooner than random sampling. Falls through to the sampler only when no
    // qualifying frontier remains (near-complete exploration).
    const frontier = this.findNearestFrontier(world, playerX, playerY);
    if (frontier) {
      return frontier;
    }
    const passable =
      this.doorAwarePassable ??
      ((tx: number, ty: number): boolean => floorMap.tileMap.isPassable(tx, ty));
    const reachableDepth = this.computeExploreReachabilityDepth(floorMap, startTile, passable);

    const reachable: { x: number; y: number; dist: number }[] = [];
    const firstPassable: { x: number; y: number } | null = { x: playerX, y: playerY };
    let sawPassable = false;

    // A*-verify a passable candidate and record it if the player can actually
    // reach it. Returns true once we have gathered enough reachable candidates.
    const consider = (wx: number, wy: number): boolean => {
      if (!floorMap.isPassableAt(wx, wy)) {
        return false;
      }
      if (!sawPassable) {
        firstPassable.x = wx;
        firstPassable.y = wy;
        sawPassable = true;
      }
      const goalTile = floorMap.worldToTile(wx, wy);
      const goalIndex = floorMap.tileMap.index(goalTile.x, goalTile.y);
      if (goalIndex !== -1 && (reachableDepth[goalIndex] ?? -1) >= 1) {
        reachable.push({ x: wx, y: wy, dist: Math.hypot(wx - playerX, wy - playerY) });
      }
      return reachable.length >= EXPLORE_REACHABLE_SAMPLE_TARGET;
    };

    if (floorMap.rooms.length > 0) {
      for (let attempt = 0; attempt < EXPLORE_REACHABLE_SAMPLE_ATTEMPTS; attempt += 1) {
        const room = floorMap.rooms[this.rng.nextInt(0, floorMap.rooms.length - 1)];
        if (!room) {
          continue;
        }
        const minX = room.bounds.x + 1;
        const maxX = Math.max(minX, room.bounds.x + room.bounds.width - 2);
        const minY = room.bounds.y + 1;
        const maxY = Math.max(minY, room.bounds.y + room.bounds.height - 2);
        const tx = this.rng.nextInt(minX, maxX);
        const ty = this.rng.nextInt(minY, maxY);
        const candidate = floorMap.tileToWorld(tx, ty);
        if (consider(candidate.x, candidate.y)) {
          break;
        }
      }
    }

    if (reachable.length < EXPLORE_REACHABLE_SAMPLE_TARGET) {
      for (let attempt = 0; attempt < EXPLORE_REACHABLE_SAMPLE_ATTEMPTS; attempt += 1) {
        const tx = this.rng.nextInt(1, Math.max(1, floorMap.width - 2));
        const ty = this.rng.nextInt(1, Math.max(1, floorMap.height - 2));
        const candidate = floorMap.tileToWorld(tx, ty);
        if (consider(candidate.x, candidate.y)) {
          break;
        }
      }
    }

    if (reachable.length > 0) {
      // Bias toward the farthest reachable tiles so we keep revealing new ground
      // instead of dithering near the player, but randomise among the top few so
      // the AI does not lock into a deterministic two-corner oscillation.
      reachable.sort((a, b) => b.dist - a.dist);
      const pool = Math.min(reachable.length, EXPLORE_FAR_CANDIDATE_POOL);
      const pick = reachable[this.rng.nextInt(0, pool - 1)];
      if (pick) {
        return { x: pick.x, y: pick.y };
      }
    }

    // No reachable candidate surfaced this sweep. Hand back any passable tile we
    // saw (the dwell watchdog will force another re-roll shortly) rather than
    // stalling on the player's own position.
    return firstPassable;
  }

  private planEngagement(
    world: GameWorld,
    playerX: number,
    playerY: number,
    target: WorldTarget,
  ): { targetX: number; targetY: number; reason: string } {
    const weapon = getActiveWeapon(world);
    if (!weapon) {
      return {
        targetX: target.x,
        targetY: target.y,
        reason: `Engaging enemy at distance ${target.distance.toFixed(1)}ft`,
      };
    }

    const reachFt = Math.max(weapon.range, weapon.aoeRadius);

    // Every projectile-firing weapon (RANGED, MAGIC, THROWN, BEAM) kites at a
    // standoff instead of charging the enemy. Only TRAP — which has no projectile
    // and is dropped at the player's feet — keeps the generic close-range engage.
    if (isProjectileWeaponType(weapon.weaponType)) {
      return this.planRangedEngagement(world, playerX, playerY, target, reachFt);
    }

    if (weapon.weaponType !== WeaponType.MELEE) {
      return {
        targetX: target.x,
        targetY: target.y,
        reason: `Engaging enemy at distance ${target.distance.toFixed(1)}ft`,
      };
    }
    // weaponSystem may start a melee swing while an enemy is within reach*1.5 so a
    // closing target can enter the blade during the animation. That permissive fire
    // gate is not the blade's guaranteed hit radius; once inside it we KITE toward
    // the real weapon reach instead of parking at the outer gate.
    const strikeGateFt = reachFt * ATTACK_GATE_MULTIPLIER;
    if (target.distance <= strikeGateFt) {
      return this.computeMeleeKiteTarget(world, playerX, playerY, target, reachFt);
    }

    // Out of strike range: close in toward the orbit band (just inside the gate) so
    // the next poll can start kiting and landing hits.
    const engageBandFt = Math.max(DIRECT_MOVE_EPSILON_FT, reachFt * MELEE_HOLD_FRACTION);
    const deltaX = target.x - playerX;
    const deltaY = target.y - playerY;
    const scale = (target.distance - engageBandFt) / target.distance;
    return {
      targetX: playerX + deltaX * scale,
      targetY: playerY + deltaY * scale,
      reason: `Closing to melee range (${reachFt.toFixed(1)}ft) from ${target.distance.toFixed(1)}ft`,
    };
  }

  /**
   * Returns true when any enemy other than `primaryTarget` is within
   * KITE_BACK_THREAT_RADIUS_FT AND is positioned behind or to the side of the
   * player relative to the primary target direction. Used to decide whether to
   * use full lateral orbit (back-threat dodge) or a mostly-radial advance/retreat.
   *
   * Filters out dead (HP<=0) entities and combat-ineligible enemies (e.g.
   * dormant Floor 2 bosses) for the same reason as {@link
   * findNearestOtherEnemyDistance} / {@link computeOtherThreatEscapePush} — a
   * lingering corpse (see `DeathTimer` / `deathTimerSystem.ts`) or a not-yet-
   * active boss sitting behind the player is not a threat and should not force
   * full-lateral-orbit mode.
   */
  private hasThreatFromBehind(
    world: GameWorld,
    playerX: number,
    playerY: number,
    primaryTarget: WorldTarget,
  ): boolean {
    const fwdX = primaryTarget.x - playerX;
    const fwdY = primaryTarget.y - playerY;
    const fwdLen = Math.hypot(fwdX, fwdY);
    if (fwdLen < 0.125) return false;
    const fwdNx = fwdX / fwdLen;
    const fwdNy = fwdY / fwdLen;

    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      if (eid === primaryTarget.eid) continue;
      const health = world.stores.health.current[eid] ?? 0;
      if (health <= 0) continue;
      if (!isEnemyCombatEligible(world, eid)) continue;
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      if (!this.canPerceiveWorldPosition(world, ex, ey)) continue;
      const dx = ex - playerX;
      const dy = ey - playerY;
      const dist = Math.hypot(dx, dy);
      if (dist > KITE_BACK_THREAT_RADIUS_FT || dist < 0.125) continue;
      // Dot < 0 means the enemy is behind the player relative to primary target.
      const dot = (dx / dist) * fwdNx + (dy / dist) * fwdNy;
      if (dot < 0) return true;
    }
    return false;
  }

  /**
   * Distance (ft) to the nearest perceived, LIVING enemy within `radiusFt`,
   * optionally excluding `excludeEid` (e.g. the current engagement target),
   * or `null` if none. Used by the safe-loot detour ({@link
   * maybeDetourForLoot}) as a simple "is anything nearby at all" safety gate
   * — magnitude only, no direction needed there. For the ranged-kiting
   * escape vector itself, see {@link computeOtherThreatEscapePush}, which
   * needs each threat's position, not just the nearest distance.
   *
   * Filters out dead (HP<=0) entities and combat-ineligible enemies (e.g.
   * dormant Floor 2 bosses): a killed enemy lingers in the ECS with its
   * `Enemy`+`Position` components intact for the duration of its `DeathTimer`
   * (knockback/death-animation delay — see `deathTimerSystem.ts`), sitting at
   * the exact spot it just dropped loot. Without this filter, that corpse
   * (or a not-yet-active boss) would incorrectly count as a nearby threat and
   * permanently block the loot detour for the very drop the AI just earned.
   */
  private findNearestOtherEnemyDistance(
    world: GameWorld,
    playerX: number,
    playerY: number,
    radiusFt: number,
    excludeEid?: number,
  ): number | null {
    let nearest: number | null = null;
    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      if (excludeEid !== undefined && eid === excludeEid) continue;
      const health = world.stores.health.current[eid] ?? 0;
      if (health <= 0) continue;
      if (!isEnemyCombatEligible(world, eid)) continue;
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      if (!this.canPerceiveWorldPosition(world, ex, ey)) continue;
      const dist = Math.hypot(ex - playerX, ey - playerY);
      if (dist > radiusFt) continue;
      if (nearest === null || dist < nearest) {
        nearest = dist;
      }
    }
    return nearest;
  }

  /**
   * Accumulates an escape-push vector (raw ft, not unit length) away from
   * every perceived, LIVING enemy other than `excludeEid` that has breached
   * the `spacedOrbit` standoff ring, within `radiusFt`. `target` (the
   * globally nearest enemy — see {@link buildEngageBehavior}) is always
   * excluded here because its contribution is already handled by the primary
   * radial/strafe step; this only adds the DIRECTIONAL correction for other
   * threats a plain nearest-distance comparison could never see (since no
   * other enemy can be closer than the one already chosen as target). Each
   * contributing enemy pushes away from itself with a magnitude proportional
   * to how far it has breached the ring (`spacedOrbit - dist`), and the
   * summed vector is clamped to KITE_RADIAL_STEP_FT so a large swarm can't
   * overwhelm the primary target's own orbit/strafe motion.
   *
   * Filters out dead (HP<=0) entities and combat-ineligible enemies (e.g.
   * dormant Floor 2 bosses) for the same reason as {@link
   * findNearestOtherEnemyDistance} — a lingering corpse (see `DeathTimer` /
   * `deathTimerSystem.ts`) or a not-yet-active boss is not an active threat
   * and should not bend the kite path.
   */
  private computeOtherThreatEscapePush(
    world: GameWorld,
    playerX: number,
    playerY: number,
    radiusFt: number,
    spacedOrbit: number,
    excludeEid: number,
  ): { x: number; y: number } {
    let pushX = 0;
    let pushY = 0;
    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      if (eid === excludeEid) continue;
      const health = world.stores.health.current[eid] ?? 0;
      if (health <= 0) continue;
      if (!isEnemyCombatEligible(world, eid)) continue;
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      if (!this.canPerceiveWorldPosition(world, ex, ey)) continue;
      let dx = playerX - ex;
      let dy = playerY - ey;
      let dist = Math.hypot(dx, dy);
      if (dist > radiusFt) continue;
      const breach = spacedOrbit - dist;
      if (breach <= 0) continue;
      if (dist < 0.125) {
        // Enemy is on top of us — same arbitrary outward axis the primary
        // target's dead-zone uses (see computeRangedKiteTarget), so a
        // coincident secondary threat still contributes a directional push
        // instead of silently vanishing at the exact moment it has breached
        // the ring the most.
        dx = 0.125;
        dy = 0;
        dist = 0.125;
      }
      const invLen = 1 / dist;
      pushX += dx * invLen * breach;
      pushY += dy * invLen * breach;
    }
    const pushLen = Math.hypot(pushX, pushY);
    if (pushLen > KITE_RADIAL_STEP_FT) {
      const scale = KITE_RADIAL_STEP_FT / pushLen;
      pushX *= scale;
      pushY *= scale;
    }
    return { x: pushX, y: pushY };
  }

  /**
   * Whether predictive travel steering should drive the heading this frame.
   * EXPLORE always steers (the long-haul dance around mobs); long-range COLLECT
   * steers until close to the pickup (the final harvest-overlap approach is left
   * to Track A's close-range slide); ENGAGE / RETREAT / INTERACT never steer —
   * they own their own movement.
   */
  private shouldTravelSteer(playerX: number, playerY: number): boolean {
    const s = this.decision.state;
    if (s === AIState.EXPLORE) {
      return true;
    }
    if (s === AIState.COLLECT) {
      if (this.decision.targetX === null || this.decision.targetY === null) {
        return true;
      }
      const dx = this.decision.targetX - playerX;
      const dy = this.decision.targetY - playerY;
      return Math.hypot(dx, dy) > TRAVEL_COLLECT_MIN_STEER_DIST_FT;
    }
    return false;
  }

  /**
   * Thin ECS→pure-input wrapper around {@link pickSafeTravelHeading}. Reads
   * perceived hostiles, the player's speed, and a door-aware passability probe,
   * then delegates the heading choice to the pure, deterministic, damage-agnostic
   * travel-steering module. All game state is read-only here.
   */
  private computeTravelSteering(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
    objDirX: number,
    objDirY: number,
  ): TravelSteeringResult {
    const playerSpeed = this.getPlayerSpeedFtPerFrame(world, playerEid);
    const runPlan = this.estimateCurrentRunPlan(world, playerEid, playerX, playerY, playerSpeed);
    this.lastRunPlan = runPlan;
    const fallbackObjective = projectTacticalObjectiveLookahead(
      playerX,
      playerY,
      objDirX,
      objDirY,
      TACTICAL_OPPORTUNITY_SCAN_RADIUS_FT,
    );
    const objectiveX = this.decision.targetX ?? fallbackObjective.x;
    const objectiveY = this.decision.targetY ?? fallbackObjective.y;
    const tacticalOpportunities = this.evaluateTacticalObjectiveOpportunities(
      world,
      playerX,
      playerY,
      objectiveX,
      objectiveY,
      runPlan,
      playerSpeed,
    );
    this.lastTacticalOpportunityEvaluation = tacticalOpportunities;
    const acceptedPickups: TravelPickup[] = tacticalOpportunities.acceptedPickups.map((pickup) => ({
      eid: pickup.id,
      kind: pickup.pickupKind,
      x: pickup.x,
      y: pickup.y,
      weight: pickup.travelWeight,
    }));
    this.tacticalTravelOwnsLoot = acceptedPickups.length > 0;

    // Perceived hostiles within the threat radius (same perception gate the rest
    // of the AI uses, so steering never reacts to enemies the player can't see).
    const threats: TravelThreat[] = [];
    const enemies = query(world.ecs, [Enemy, Position, Velocity, Health]);
    for (const eid of enemies) {
      if (eid === undefined) {
        continue;
      }
      if ((world.stores.health.current[eid] ?? 0) <= 0) {
        continue;
      }
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      if (Math.hypot(ex - playerX, ey - playerY) > TRAVEL_THREAT_RADIUS_FT) {
        continue;
      }
      if (!this.canPerceiveWorldPosition(world, ex, ey)) {
        continue;
      }
      threats.push({
        x: ex,
        y: ey,
        vx: world.stores.velocity.x[eid] ?? 0,
        vy: world.stores.velocity.y[eid] ?? 0,
        bodyRadiusFt: TRAVEL_BODY_RADIUS_FT,
      });
    }

    // Door-aware passability in world coordinates (wraps the tile-space predicate
    // so steering never refuses a quest-critical closed-but-openable door).
    const floorMap = world.floorMap;
    const doorAwarePassable = this.doorAwarePassable;
    const probePassable = (worldX: number, worldY: number): boolean => {
      if (!floorMap) {
        return true;
      }
      const tile = floorMap.worldToTile(worldX, worldY);
      return doorAwarePassable
        ? doorAwarePassable(tile.x, tile.y)
        : floorMap.tileMap.isPassable(tile.x, tile.y);
    };

    // Continuity uses last frame's *smoothed* output heading (unit); a ~0 heading
    // yields a neutral (0,0) prevDir so re-entry from ENGAGE never snaps sideways.
    const smoothMag = Math.hypot(this.smoothMoveX, this.smoothMoveY);
    const prevDirX = smoothMag > TRAVEL_HEADING_EPSILON ? this.smoothMoveX / smoothMag : 0;
    const prevDirY = smoothMag > TRAVEL_HEADING_EPSILON ? this.smoothMoveY / smoothMag : 0;

    // Time-pressure envelope: as the floor-collapse panic ramps 0→1, ease the
    // spacing target toward the hard (contact) gap so the runner stops spending
    // time on wide avoidance arcs it can no longer afford and beelines to finish.
    // It still clears actual contact (hard-gap floor); only the *comfort* spacing
    // is surrendered. Damage-agnostic — driven by remaining time, not hostile damage.
    const panicProfile = this.getCollapsePanicProfile(world);
    const panic = panicProfile.panic;
    const baseParams: TravelSteeringParams =
      panic > 0
        ? {
            ...TRAVEL_PARAMS,
            safeGapFt: TRAVEL_SAFE_GAP_FT - (TRAVEL_SAFE_GAP_FT - TRAVEL_HARD_GAP_FT) * panic,
          }
        : TRAVEL_PARAMS;
    const params: TravelSteeringParams =
      acceptedPickups.length > 0 && !panicProfile.beeline
        ? { ...baseParams, wLoot: TACTICAL_TRAVEL_W_LOOT }
        : baseParams;

    const input: TravelSteeringInput = {
      px: playerX,
      py: playerY,
      objDirX,
      objDirY,
      prevDirX,
      prevDirY,
      playerSpeedFtPerFrame: playerSpeed,
      orbitSign: this.kiteOrbitSign,
      panic: panicProfile.beeline,
      weaponReachFt: 0,
      farmEligible: false,
      threats,
      pickups: acceptedPickups,
      probePassable,
    };
    return pickSafeTravelHeading(input, params);
  }

  /** Player health as a 0..1 fraction, or 1 when no player is found. */
  private getPlayerHealthFraction(world: GameWorld): number {
    const players = query(world.ecs, [Player, Health]);
    const eid = players[0];
    if (eid === undefined) return 1;
    const cur = world.stores.health.current[eid] ?? 1;
    const max = world.stores.health.max[eid] ?? 1;
    return max > 0 ? cur / max : 1;
  }

  /**
   * Melee kite: advance/retreat along the enemy axis so the weapon lands reliably,
   * while adding a small lateral juke to stay a moving target. Full lateral orbit
   * is used only when another enemy is approaching from behind.
   *
   * - Desired orbit radius stutter-steps with weapon cooldown: pull into the inner
   *   strike band when a swing is READY (so the hit lands), ease out to the gate
   *   edge while on cooldown (max dodge distance, still able to resume).
   * - If the enemy's own attackRange is smaller than our gate, hug just outside it
   *   so we poke from safety. For long-range bosses (attackRange >> reach) this is
   *   geometrically impossible, so we simply orbit in close and rely on motion.
   * - Orbit direction is persistent and reverses periodically (or immediately when
   *   the strafe direction is walled), producing steady juking — distinct from the
   *   walk-away/walk-back pickup wiggle.
   */
  private computeMeleeKiteTarget(
    world: GameWorld,
    playerX: number,
    playerY: number,
    target: WorldTarget,
    reachFt: number,
  ): { targetX: number; targetY: number; reason: string } {
    const readiness = getActiveWeaponReadiness(world);
    const ready = readiness?.ready ?? true;
    // Micro-spacing: poke into the strike band as a swing comes ready and ease
    // back out toward the recover band immediately after it fires, so the player
    // dodges between hits instead of standing in the enemy's face. cooldownFrac is
    // ~1 right after a swing and decays to 0 as the next swing readies, producing a
    // smooth in/out oscillation locked to the weapon's own cadence.
    const cooldownFrac =
      readiness && readiness.cooldownMs > 0
        ? Math.max(0, Math.min(1, readiness.remainingMs / readiness.cooldownMs))
        : 0;

    const innerOrbitFallback = Math.max(DIRECT_MOVE_EPSILON_FT, reachFt * MELEE_HOLD_FRACTION);
    const swingRadius = reachFt;
    const strikeGate = reachFt * ATTACK_GATE_MULTIPLIER;
    let innerOrbit: number;
    let outerOrbit: number;
    if (CONTACT_SAFE_ORBIT_FT <= swingRadius) {
      // Weapon out-reaches swarm body contact: anchor the micro-spacing band JUST
      // outside contact (strike, hits still land within the swing radius) and poke a
      // modest amount further out on cooldown (dodge), capped at the strike gate.
      innerOrbit = Math.min(swingRadius, CONTACT_SAFE_ORBIT_FT);
      outerOrbit = Math.min(strikeGate, innerOrbit + MELEE_DODGE_AMPLITUDE_FT);
    } else {
      // Very short weapon (e.g. knife, reach < contact): cannot poke from outside
      // contact while still landing hits, so keep the tight reach-fraction strike
      // band and accept the trade.
      innerOrbit = innerOrbitFallback;
      outerOrbit = Math.max(innerOrbit, reachFt * MELEE_RECOVER_HOLD_FRACTION);
    }
    let desiredOrbit = innerOrbit + (outerOrbit - innerOrbit) * cooldownFrac;

    const enemyAttackFt = world.stores.enemyBehavior.attackRange[target.eid] ?? 0;
    // When wounded, prioritise not being hit, but never expand beyond the blade's
    // guaranteed center-line reach. weaponSystem's larger fire gate only starts the
    // swing early; parking at that gate can leave a stationary target outside the
    // blade for the entire animation. At healthy HP we keep the tighter recover band
    // for maximum DPS / AoE cleave.
    const defensive = this.getPlayerHealthFraction(world) < MELEE_DEFENSIVE_HP_FRACTION;
    const safeOrbitCap = defensive ? swingRadius : outerOrbit;
    if (enemyAttackFt > 0) {
      const safeOrbit = enemyAttackFt + KITE_DODGE_BUFFER_FT;
      if (safeOrbit <= safeOrbitCap) {
        // We can stand outside the enemy's strike range and still land hits.
        desiredOrbit = Math.min(safeOrbitCap, Math.max(desiredOrbit, safeOrbit));
      } else if (defensive) {
        // Enemy outranges the weapon (e.g. a ranged boss): hold at real blade reach
        // rather than retreating into a no-damage orbit.
        desiredOrbit = Math.max(desiredOrbit, safeOrbitCap);
      }
    }

    // Deterministic periodic orbit reversal so the player keeps juking.
    if (world.frameCount - this.kiteSignFrame >= KITE_FLIP_FRAMES) {
      this.kiteOrbitSign = this.kiteOrbitSign === 1 ? -1 : 1;
      this.kiteSignFrame = world.frameCount;
    }

    let rx = playerX - target.x;
    let ry = playerY - target.y;
    let dist = Math.hypot(rx, ry);
    if (dist < 0.125) {
      // Enemy is on top of us — pick an arbitrary outward axis to escape along.
      rx = 0.125;
      ry = 0;
      dist = 0.125;
    }
    const ux = rx / dist;
    const uy = ry / dist;
    // Radial correction toward the desired orbit radius (+ux pushes outward).
    const radialMag = Math.max(
      -KITE_RADIAL_STEP_FT,
      Math.min(KITE_RADIAL_STEP_FT, desiredOrbit - dist),
    );

    // Use full lateral orbit only when an enemy is closing from behind; otherwise
    // favour forward/backward motion (radial) with a small lateral juke so the
    // weapon stays on target instead of constantly circling past it.
    const backThreat = this.hasThreatFromBehind(world, playerX, playerY, target);
    const strafeFt = backThreat ? KITE_STEP_FT : KITE_STRAFE_FT;

    const buildStep = (sign: 1 | -1): { x: number; y: number } => {
      const tx = -uy * sign;
      const ty = ux * sign;
      let sx = ux * radialMag + tx * strafeFt;
      let sy = uy * radialMag + ty * strafeFt;
      const slen = Math.hypot(sx, sy) || 1;
      sx = (sx / slen) * KITE_STEP_FT;
      sy = (sy / slen) * KITE_STEP_FT;
      return { x: sx, y: sy };
    };

    let step = buildStep(this.kiteOrbitSign);
    // Wall-aware juking: if the strafe direction is blocked, reverse so the player
    // dodges along open space instead of grinding the wall.
    if (
      !hasClearLineOfSight(world.floorMap, playerX, playerY, playerX + step.x, playerY + step.y)
    ) {
      const flipped: 1 | -1 = this.kiteOrbitSign === 1 ? -1 : 1;
      const flippedStep = buildStep(flipped);
      if (
        hasClearLineOfSight(
          world.floorMap,
          playerX,
          playerY,
          playerX + flippedStep.x,
          playerY + flippedStep.y,
        )
      ) {
        this.kiteOrbitSign = flipped;
        this.kiteSignFrame = world.frameCount;
        step = flippedStep;
      }
    }

    return {
      targetX: playerX + step.x,
      targetY: playerY + step.y,
      reason: `Kiting enemy at ${target.distance.toFixed(1)}ft (${ready ? 'strike' : 'dodge'}, orbit ${desiredOrbit.toFixed(1)}ft)`,
    };
  }

  /**
   * Ranged engagement: approach to 75 % of weapon range, then orbit to stay at
   * that distance instead of charging the enemy. When the enemy closes in
   * (distance drops below the tolerance band), the kite step's radial correction
   * pushes the AI back out to the standoff orbit radius.
   */
  private planRangedEngagement(
    world: GameWorld,
    playerX: number,
    playerY: number,
    target: WorldTarget,
    reachFt: number,
  ): { targetX: number; targetY: number; reason: string } {
    const healthyOrbit = Math.max(
      CONTACT_SAFE_ORBIT_FT,
      Math.min(reachFt * RANGED_STANDOFF_FRACTION, RANGED_STANDOFF_ABS_FT),
    );
    const wounded = this.getPlayerHealthFraction(world) < RANGED_DEFENSIVE_HP_FRACTION;
    const pressureRadius = this.rangedDefensiveSpacing
      ? this.config.rangedSafeDistance * RANGED_DEFENSIVE_RELEASE_MULTIPLIER
      : this.config.rangedSafeDistance;
    const pressureThreat = wounded
      ? this.findNearestEnemy(world, playerX, playerY, pressureRadius)
      : null;
    this.rangedDefensiveSpacing = wounded && pressureThreat !== null;
    const desiredOrbit = this.rangedDefensiveSpacing
      ? Math.max(
          healthyOrbit,
          Math.min(reachFt * RANGED_DEFENSIVE_REACH_FRACTION, RANGED_DEFENSIVE_ABS_FT),
        )
      : healthyOrbit;
    const contactThreatRadius = desiredOrbit + RANGED_APPROACH_BUFFER_FT;
    let activeTarget = target;

    // If a different enemy has already pushed into the standoff/contact bubble,
    // kite that immediate threat first instead of continuing to "close" on a
    // farther target and tanking free body-contact hits on the way in.
    if (target.distance > contactThreatRadius) {
      const nearbyThreat = this.findNearestEnemy(world, playerX, playerY, contactThreatRadius);
      if (nearbyThreat && nearbyThreat.eid !== target.eid) {
        activeTarget = nearbyThreat;
      }
    }

    // Safe loot detour: fires only when activeTarget is in the "closing"
    // phase (beyond contactThreatRadius — not yet in orbit), AND no OTHER
    // perceived threat is within SAFE_LOOT_ENEMY_CLEARANCE_FT. Passing
    // activeTarget separately from the OTHER-enemies scan means short-range
    // projectile weapons (e.g. throwing-knife, contactThreatRadius ~9ft,
    // engage radius ~30ft) have a valid window: enemy at 10-30ft qualifies
    // as "closing-phase clear" even though they're within engage range.
    const lootDetour = this.maybeDetourForLoot(
      world,
      playerX,
      playerY,
      activeTarget,
      contactThreatRadius,
    );
    if (lootDetour) {
      return lootDetour;
    }

    if (activeTarget.distance > contactThreatRadius) {
      // Too far to orbit: navigate toward a point at the desired standoff distance
      // from the enemy so A* can plan the full route.
      const dx = activeTarget.x - playerX;
      const dy = activeTarget.y - playerY;
      const scale = (activeTarget.distance - desiredOrbit) / activeTarget.distance;
      return {
        targetX: playerX + dx * scale,
        targetY: playerY + dy * scale,
        reason: `Closing to ranged standoff (${desiredOrbit.toFixed(1)}ft) from ${activeTarget.distance.toFixed(1)}ft`,
      };
    }

    // At or inside the standoff band: fall back to the orbit-kite step. The
    // radial correction keeps the distance near desiredOrbit while orbiting
    // (pushing away if too close, nudging in if slightly too far).
    return this.computeRangedKiteTarget(world, playerX, playerY, activeTarget, desiredOrbit);
  }

  /**
   * Opportunistic "safe loot detour" for ranged kiting. Only fires when the
   * maintainer's stated condition holds:
   * 1. `activeTarget` is in the **closing** phase (distance > `contactThreatRadius`) —
   *    once orbiting, it's too close to safely break off.
   * 2. No OTHER perceived, living enemy is within {@link SAFE_LOOT_ENEMY_CLEARANCE_FT}.
   * 3. Loot exists within {@link LOOT_DETOUR_MAX_FT}.
   *
   * Splitting the active-target check from the secondary-scan lets short-range
   * projectile weapons (e.g. throwing-knife, engage radius ~30 ft, orbit ~6 ft)
   * reach the loot branch during their closing phase (enemy 10–30 ft away, no
   * flankers) — previously unreachable because the all-enemy 30 ft scan always
   * found the active target itself. Deliberately returns a plain movement target
   * rather than switching `AIState` to COLLECT — normal orbit-kiting resumes the
   * instant this returns null again (loot collected, or a threat re-closes).
   */
  private maybeDetourForLoot(
    world: GameWorld,
    playerX: number,
    playerY: number,
    activeTarget: WorldTarget,
    contactThreatRadius: number,
  ): { targetX: number; targetY: number; reason: string } | null {
    // Active target must be in the closing phase (not yet in orbit range).
    if (activeTarget.distance <= contactThreatRadius) {
      return null;
    }
    // No OTHER living enemy may be within the clearance radius.
    const nearestOtherThreatDist = this.findNearestOtherEnemyDistance(
      world,
      playerX,
      playerY,
      SAFE_LOOT_ENEMY_CLEARANCE_FT,
      activeTarget.eid,
    );
    if (nearestOtherThreatDist !== null) {
      return null;
    }
    const loot = this.findNearestLoot(world, playerX, playerY);
    if (!loot || loot.distance > LOOT_DETOUR_MAX_FT) {
      return null;
    }
    return {
      targetX: loot.x,
      targetY: loot.y,
      reason: `Detouring for ${loot.kind} loot mid-kite (${loot.distance.toFixed(1)}ft, active threat ${activeTarget.distance.toFixed(1)}ft away, no flanker within ${SAFE_LOOT_ENEMY_CLEARANCE_FT.toFixed(0)}ft)`,
    };
  }

  /**
   * Ranged orbit step: move along the player-enemy axis (advance to close gap,
   * retreat when enemy pushes in) with a small lateral juke, using the same
   * orbit-sign flip infrastructure as melee kiting. Full lateral orbit activates
   * when an enemy is approaching from behind. The radial correction component
   * automatically retreats when `target` closes in — and, via
   * {@link computeOtherThreatEscapePush}, the escape vector is also bent away
   * from any OTHER nearby enemy that has breached the standoff ring, not just
   * `target`, so a packed swarm can't land free contact-range hits from an
   * angle the AI isn't currently retreating toward.
   */
  private computeRangedKiteTarget(
    world: GameWorld,
    playerX: number,
    playerY: number,
    target: WorldTarget,
    desiredOrbit: number,
  ): { targetX: number; targetY: number; reason: string } {
    // Reuse the shared orbit-direction flip so the AI juke-dodges periodically.
    if (world.frameCount - this.kiteSignFrame >= KITE_FLIP_FRAMES) {
      this.kiteOrbitSign = this.kiteOrbitSign === 1 ? -1 : 1;
      this.kiteSignFrame = world.frameCount;
    }

    let rx = playerX - target.x;
    let ry = playerY - target.y;
    let dist = Math.hypot(rx, ry);
    if (dist < 0.125) {
      // Enemy is on top of us — pick an arbitrary outward axis to escape along.
      rx = 0.125;
      ry = 0;
      dist = 0.125;
    }
    const ux = rx / dist;
    const uy = ry / dist;
    // Micro-spacing: ease farther out while the shot is on cooldown, then settle
    // back to the standoff radius as it readies — the same in/out stutter the
    // melee kite uses, so every weapon keeps moving instead of holding a static
    // ring. cooldownFrac is ~1 right after firing and decays to 0 when ready.
    const readiness = getActiveWeaponReadiness(world);
    const cooldownFrac =
      readiness && readiness.cooldownMs > 0
        ? Math.max(0, Math.min(1, readiness.remainingMs / readiness.cooldownMs))
        : 0;
    const spacedOrbit = desiredOrbit * (1 + RANGED_RECOVER_EXTRA_FRACTION * cooldownFrac);
    // Positive radialMag = push away from enemy (when too close).
    // Negative radialMag = nudge toward enemy (when slightly too far).
    const radialMag = Math.max(
      -KITE_RADIAL_STEP_FT,
      Math.min(KITE_RADIAL_STEP_FT, spacedOrbit - dist),
    );

    // Multi-threat radial defense: `target` is always whichever enemy is
    // globally nearest (recomputed fresh every poll — see buildEngageBehavior),
    // so a plain min-distance comparison against other enemies can never fire
    // (no other enemy can be closer than the one already chosen as nearest).
    // The real gap is DIRECTIONAL: retreating straight away from `target`'s
    // axis can walk the player straight into a second/third enemy closing in
    // from a different angle in a packed swarm, since that enemy's position
    // never contributes to the escape vector at all. Fix: accumulate an
    // explicit escape push away from every OTHER perceived enemy that has
    // breached the standoff ring, and add it to the primary radial/strafe step
    // below — so closing threats from any angle bend the kite path away from
    // them, not just from the nominal target.
    const otherThreatPush = this.computeOtherThreatEscapePush(
      world,
      playerX,
      playerY,
      RANGED_MULTI_THREAT_SCAN_FT,
      spacedOrbit,
      target.eid,
    );

    // Prefer radial (forward/backward) motion; orbit fully only when flanked.
    const backThreat = this.hasThreatFromBehind(world, playerX, playerY, target);
    const strafeFt = backThreat ? KITE_STEP_FT : KITE_STRAFE_FT;

    const buildStep = (sign: 1 | -1): { x: number; y: number } => {
      const tx = -uy * sign;
      const ty = ux * sign;
      let sx = ux * radialMag + tx * strafeFt + otherThreatPush.x;
      let sy = uy * radialMag + ty * strafeFt + otherThreatPush.y;
      const slen = Math.hypot(sx, sy) || 1;
      sx = (sx / slen) * KITE_STEP_FT;
      sy = (sy / slen) * KITE_STEP_FT;
      return { x: sx, y: sy };
    };

    let step = buildStep(this.kiteOrbitSign);
    // Wall-aware: reverse orbit direction if the strafe path is blocked.
    if (
      !hasClearLineOfSight(world.floorMap, playerX, playerY, playerX + step.x, playerY + step.y)
    ) {
      const flipped: 1 | -1 = this.kiteOrbitSign === 1 ? -1 : 1;
      const flippedStep = buildStep(flipped);
      if (
        hasClearLineOfSight(
          world.floorMap,
          playerX,
          playerY,
          playerX + flippedStep.x,
          playerY + flippedStep.y,
        )
      ) {
        this.kiteOrbitSign = flipped;
        this.kiteSignFrame = world.frameCount;
        step = flippedStep;
      }
    }

    return {
      targetX: playerX + step.x,
      targetY: playerY + step.y,
      reason: `Ranged orbit at ${dist.toFixed(0)}ft (standoff ${spacedOrbit.toFixed(1)}ft)`,
    };
  }

  private findNearestRelevantNpc(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
  ): NpcTarget | null {
    const npcs = query(world.ecs, [Npc, Position]);
    const candidates: (NpcTarget & PoiCandidate)[] = [];

    for (const eid of npcs) {
      if (eid === undefined) {
        continue;
      }
      const instance = world.npcs.get(eid);
      if (!instance) {
        continue;
      }
      this.discoveredNpcDefs.add(instance.defId);
      const interactionReason = this.getNpcInteractionReason(world, playerEid, eid);
      this.neededInteractionReasonByNpc.set(instance.defId, interactionReason);

      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      if (!this.canPerceiveWorldPosition(world, x, y)) {
        continue;
      }
      // A POI is only worth seeking while it still needs interaction; handled
      // NPCs (interactionReason === null) stay discovered but become irrelevant.
      if (world.playerInSafeRoom && !isPointInSafeSpace(world, x, y)) {
        continue;
      }
      candidates.push({
        eid,
        x,
        y,
        distance: Math.hypot(x - playerX, y - playerY),
        defId: instance.defId,
        interactionReason: interactionReason ?? AINpcInteractionAction.GENERIC_INTERACTION,
        relevant: Boolean(interactionReason),
      });
    }

    const pick = pickNearestPoi(
      candidates,
      playerX,
      playerY,
      world.playerInSafeRoom ? Number.POSITIVE_INFINITY : this.config.scanRadius,
    );
    if (!pick) {
      return null;
    }
    return {
      eid: pick.eid,
      x: pick.x,
      y: pick.y,
      distance: pick.distance,
      defId: pick.defId,
      interactionReason: pick.interactionReason,
    };
  }

  private getNpcInteractionReason(
    world: GameWorld,
    playerEid: number,
    npcEid: number,
  ): AINpcInteractionActionValue | null {
    const instance = world.npcs.get(npcEid);
    if (!instance) {
      return null;
    }

    const familyState = world.floorExtendedState?.familyState;
    if (familyState) {
      // Floor 2 intro gate: until the broker intro goal is complete, the broker
      // is the only relevant interaction target.
      if (instance.defId === 'the-broker') {
        return world.goalFlags.get(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID) === true
          ? null
          : AINpcInteractionAction.MEET_BROKER_INTRO;
      }
      // Floor 2 currently has no scripted non-broker NPC interaction goals in the
      // BT pipeline; treat them as irrelevant so headless progression does not
      // loop on unsupported INTERACT actions.
      return null;
    }

    const floorScenario = world.floorScenario;
    if (!floorScenario) {
      return AINpcInteractionAction.GENERIC_INTERACTION;
    }

    const objective = floorScenario.objective;
    const shopStage = getShopkeeperStage(world);
    const bag = world.inventories.get(playerEid);
    const hasFetchItem = bag ? hasItem(bag, SHOPKEEPER_FETCH_ITEM_ID) : false;

    switch (instance.defId) {
      case 'tutorial-goon':
        return world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID)
          ? null
          : AINpcInteractionAction.ACCEPT_TUTORIAL_QUEST;
      case 'shopkeeper':
        if (world.playerLevel.level < FLOOR1_QUEST_UNLOCK_LEVEL) {
          // The merchant errand is gated behind reaching level 2.
          return null;
        }
        if (shopStage === 'not-met') {
          return AINpcInteractionAction.MEET_SHOPKEEPER;
        }
        if (shopStage === 'awaiting-prize' && hasFetchItem) {
          return AINpcInteractionAction.RETURN_SHOPKEEPER_PRIZE;
        }
        if (shopStage === 'ready-to-buy' && world.playerGold >= SHOPKEEPER_EQUIPMENT_COST) {
          return AINpcInteractionAction.BUY_SHOPKEEPER_EQUIPMENT;
        }
        return null;
      case 'spell-quest-giver':
        if (
          world.playerLevel.level < FLOOR1_QUEST_UNLOCK_LEVEL &&
          !world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)
        ) {
          // The Spell Broker's quest is gated behind reaching level 2.
          return null;
        }
        if (!world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)) {
          return AINpcInteractionAction.ACCEPT_SPELL_QUEST;
        }
        if (objective.bossBattles.get('slime-rat')!.defeated && !world.featureUnlocks.spells) {
          return AINpcInteractionAction.CLAIM_SPELL_REWARD;
        }
        return null;
      default:
        return null;
    }
  }

  getDecision(): AIDecision {
    return {
      ...this.decision,
      debug: this.decision.debug ? { ...this.decision.debug } : null,
    };
  }

  /** Current committed Floor 2 hunt family, exposed for production telemetry. */
  getFloor2HuntFamilyId(): FamilyId | null {
    return this.floor2HuntFamilyId;
  }

  /**
   * Current Track B opportunistic vector values, exposed for visualization
   * and debugging. Updated each poll; (0,0) means the corresponding layer
   * did not fire this frame.
   */
  getOpportunisticDebug(): {
    pullX: number;
    pullY: number;
    farmX: number;
    farmY: number;
    dodgeX: number;
    dodgeY: number;
  } {
    return {
      pullX: this.opportunisticPullX,
      pullY: this.opportunisticPullY,
      farmX: this.farmPullX,
      farmY: this.farmPullY,
      dodgeX: this.dodgeVecX,
      dodgeY: this.dodgeVecY,
    };
  }

  /**
   * Last predictive travel-steering result, or null when steering did not drive
   * the most recent poll (non-travel state, disabled, or a zero objective
   * heading). Mirrors {@link getOpportunisticDebug} for deterministic tests.
   */
  getTravelSteeringDebug(): TravelSteeringResult | null {
    return this.lastTravelSteering;
  }

  getTacticalRunDebug(): TacticalRunDebug {
    return {
      runPlan: this.lastRunPlan,
      decisionRunPlan: null,
      opportunities: this.lastTacticalOpportunityEvaluation,
    };
  }

  /** A/B axis 1: the pathing mode this AI was constructed with. */
  getPathingMode(): AIPathingModeValue {
    return this.config.pathingMode;
  }

  /** A/B axis 2: the decision mode this AI was constructed with. */
  getDecisionMode(): AIDecisionModeValue {
    return this.config.decisionMode;
  }

  getNavigationDebug(): AINavigationDebug {
    return {
      pathWaypoints: this.pathWaypoints.map((waypoint) => ({ ...waypoint })),
      pathIndex: this.pathIndex,
      pathGoalKey: this.pathGoalKey,
      stuckFrames: this.stuckFrames,
    };
  }

  getNpcMemoryDebug(): AINpcMemoryDebug {
    const neededInteractionReasons: Record<string, string | null> = {};
    for (const [defId, reason] of this.neededInteractionReasonByNpc.entries()) {
      neededInteractionReasons[defId] = reason;
    }
    return {
      discoveredNpcDefs: Array.from(this.discoveredNpcDefs.values()).sort(),
      talkedNpcDefs: Array.from(this.talkedNpcDefs.values()).sort(),
      neededInteractionReasons,
    };
  }

  /**
   * Locked doors the AI currently knows it cannot pass, with the unlock
   * requirement (goal flags / item ids / timer) for each. Surfaced for debug
   * overlays and to make the "remember locked doors" behavior observable.
   */
  getLockedDoorMemory(): AILockedDoorMemory[] {
    return Array.from(this.knownLockedDoors.values())
      .map((door) => ({
        ...door,
        unlockRequirement: {
          goalIds: [...door.unlockRequirement.goalIds],
          itemIds: [...door.unlockRequirement.itemIds],
          timerMs: door.unlockRequirement.timerMs,
        },
      }))
      .sort((a, b) => a.eid - b.eid);
  }

  /**
   * Get the behavior tree for visualization.
   */
  getTree(): BehaviorTree {
    return this.tree;
  }

  getHostileEncounterLifecycleDebug(): {
    observedRevision: number;
    invalidationCount: number;
    lastInvalidationFrame: number;
  } {
    return {
      observedRevision: this.observedHostileEncounterRevision,
      invalidationCount: this.hostileEncounterInvalidationCount,
      lastInvalidationFrame: this.lastHostileEncounterInvalidationFrame,
    };
  }

  reset(): void {
    this.observedHostileEncounterRevision = 0;
    this.hostileEncounterInvalidationCount = 0;
    this.lastHostileEncounterInvalidationFrame = -1;
    this.decision = {
      state: AIState.EXPLORE,
      targetEid: null,
      targetX: null,
      targetY: null,
      reason: 'Reset',
      npcInteraction: null,
      debug: null,
    };
    this.pathWaypoints = [];
    this.pathIndex = 0;
    this.pathGoalKey = null;
    this.disposeNavmesh();
    this.moveWedgeFrames = 0;
    this.moveWedgeLastX = Number.NaN;
    this.moveWedgeLastY = Number.NaN;
    this.stuckFrames = 0;
    this.ignoredLootUntilFrame.clear();
    this.ignoredEnemyUntilFrame.clear();
    this.targetReachableCache.clear();
    this.npcInteractionAnchorCache.clear();
    this.engageNoProgressFrames = 0;
    this.engageBaselinesByEid.clear();
    this.rangedDefensiveSpacing = false;
    this.collectDwellActive = false;
    this.collectDwellAnchorX = 0;
    this.collectDwellAnchorY = 0;
    this.collectDwellFrames = 0;
    this.xpCleanupMode = null;
    this.xpCleanupAnchorX = 0;
    this.xpCleanupAnchorY = 0;
    this.xpCleanupStartFrame = 0;
    this.xpCleanupCooldownUntilFrame = 0;
    this.xpCleanupCombatWindowUntilFrame = -1;
    this.exploreDwell.reset();
    this.progressGoalSuppressedUntilFrame = 0;
    this.progressGoalSuppressionSource = null;
    this.pendingSuppressedProgressNavDebug = null;
    this.floor2HuntMap = null;
    this.floor2HuntFamilyId = null;
    this.floor2HuntPatrolIndex = 0;
    this.floor2HuntPatrolTarget = null;
    this.floor2HuntLastKillCount = 0;
    this.floor2HuntLastProgressFrame = 0;
    this.floor2HuntCadenceStartFrame = 0;
    this.floor2HuntHandledSuppressionUntilFrame = 0;
    this.floor2HuntPatrolTiles.clear();
    this.globalDwellActive = false;
    this.globalDwellAnchorX = 0;
    this.globalDwellAnchorY = 0;
    this.globalDwellFrames = 0;
    this.globalDwellBestEnemyDist = Number.POSITIVE_INFINITY;
    this.globalDwellBestEnemyHp = Number.POSITIVE_INFINITY;
    this.questProgressActive = false;
    this.questProgressBestScore = 0;
    this.questProgressStallFrames = 0;
    this.discoveredNpcDefs.clear();
    this.talkedNpcDefs.clear();
    this.neededInteractionReasonByNpc.clear();
    this.doorAwarePassable = null;
    this.knownLockedDoors.clear();
    this.resolvedGoalCache = null;
    // Restore the reachable-goal memo + navigation epoch to their fresh-construction
    // state, mirroring resolvedGoalCache/targetReachableCache above. Leaving
    // navSignature set would let a reused provider skip the navEpoch bump when a new
    // world's (floor + blocked-door) signature collides with the previous one, and
    // serve stale reachability from a different floor topology.
    this.resolveGoalMemo.clear();
    this.resolveGoalMemoEpoch = -1;
    this.navEpoch = 0;
    this.navSignature = null;
    this.floor1MiddleChainCache = null;
    this.runPlanCacheKey = null;
    this.runPlanCache = null;
    this.hasPerceptionData = false;
    this.frontierBfsVisited = null;
    this.retreating = false;
    this.rangedEmergencyRetreating = false;
    this.retreatTargetX = null;
    this.retreatTargetY = null;
    this.retreatRepickFrame = 0;
    this.retreatThreatEid = null;
    this.lastArenaLockinEid = null;
    this.lastArenaLockinKind = null;
    this.opportunisticPullX = 0;
    this.opportunisticPullY = 0;
    this.farmPullX = 0;
    this.farmPullY = 0;
    this.dodgeVecX = 0;
    this.dodgeVecY = 0;
    this.prevFusedDirX = 0;
    this.prevFusedDirY = 0;
    this.fusedDebug = null;
    this.lastTravelSteering = null;
    this.lastRunPlan = null;
    this.merchantDecisionRunPlan = null;
    this.merchantDecisionRunPlanFrame = -Infinity;
    this.lastPlayerToStairsTravelMs = null;
    this.lastPlayerToStairsRefreshFrame = -Infinity;
    this.lastPlayerToStairsTileX = null;
    this.lastPlayerToStairsTileY = null;
    this.lastTacticalOpportunityEvaluation = null;
    this.tacticalTravelOwnsLoot = false;
    this.acceptedQuestCount = 0;
    this.committedDetourNpcEid = null;
    this.committedDetourBestDistance = Number.POSITIVE_INFINITY;
    this.committedDetourNoProgressFrames = 0;
    this.resetNpcApproachThreatTracking();
    this.clearSafeRoomEgressWaypoint();
  }
}
