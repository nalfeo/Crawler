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
  Velocity,
  XpGem,
  Gold,
  DroppedItem,
  Harvestable,
  Npc,
  HARVEST_RANGE_FT,
  type GameWorld,
} from '../../core/index.js';
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
import { RoomRole } from '../../shared/map-types.js';
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
import { normalizeInputDirection } from '../../shared/input.js';
import { hasItem } from '../../shared/inventory.js';
import { SeededRandom } from '../../shared/random.js';
import { createLogger } from '../../shared/logger.js';
import { WeaponType } from '../../shared/constants.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  SHOPKEEPER_FETCH_ITEM_ID,
} from '../../shared/quest-types.js';
import { AIState, type AIInputProvider, type AIDecision, type AIConfig } from './types.js';
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
import { getActiveWeapon, getActiveWeaponReadiness } from '../weaponSystem.js';
// AI tuning constants (pure values; identical runtime behavior) live in
// ./bt-ai-tuning.ts. Imported here so every reference in this file is unchanged.
import {
  DEFAULT_CONFIG,
  DIRECT_MOVE_EPSILON_FT,
  RANGED_STANDOFF_FRACTION,
  RANGED_STANDOFF_ABS_FT,
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
  PATH_CORRIDOR_HALF_WIDTH_FT,
  DETOUR_MIN_HEADING_MAGNITUDE,
  FARM_FORWARD_SCAN_RADIUS_FT,
  FARM_FORWARD_DOT_MIN,
  FARM_MIN_HEALTH_FRACTION,
  QUEST_GIVER_DETOUR_MAX_EXTRA_FT,
  QUEST_GIVER_DETOUR_MAX_EXTRA_FRACTION,
  NPC_INTERACTION_RADIUS_FT,
  NPC_APPROACH_THREAT_RADIUS_FT,
} from './bt-ai-tuning.js';
// Floor-progress scoring + its weight live in ./scoring.ts (re-exported below so
// this module's public surface is unchanged).
import { computeFloorProgressScore } from './scoring.js';
// Pure line-of-sight sampling lives in ./bt-ai-geometry.ts (unit-tested).
import { hasClearLineOfSight } from './bt-ai-geometry.js';

const logger = createLogger('game:bt-ai-provider');

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
}

interface NpcTarget extends WorldTarget {
  defId: string;
  interactionReason: string;
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

export type { AILockedDoorMemory };

/**
 * Behavior Tree AI that simulates human input.
 * Uses composable behavior tree nodes for decision-making.
 */
export class BehaviorTreeAI implements AIInputProvider {
  private readonly config: Required<AIConfig>;
  private readonly rng: SeededRandom;
  private readonly tree: BehaviorTree;
  private decision: AIDecision;
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
   * Initialized to (0, 0) at construction and persists across all polls for the
   * lifetime of this AI instance; never explicitly reset, so the blend always
   * carries over from the previous frame. */
  private smoothMoveX: number = 0;
  private smoothMoveY: number = 0;
  /**
   * Whether the AI is currently committed to a retreat. Latched so the retreat
   * condition can apply hysteresis (see {@link RETREAT_HYSTERESIS_MULT}) instead
   * of re-deciding every frame at the danger-radius boundary.
   */
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
  /**
   * Persistent melee-kite orbit direction (+1 / -1) and the frame it was last
   * flipped. Held across polls so the player circles the enemy steadily instead
   * of jittering; reversed every {@link KITE_FLIP_FRAMES} frames so it juke-dodges
   * and never grinds into a single wall.
   */
  private kiteOrbitSign: 1 | -1 = 1;
  private kiteSignFrame: number = 0;
  private readonly ignoredLootUntilFrame = new Map<number, number>();
  private readonly ignoredEnemyUntilFrame = new Map<number, number>();
  private engageTargetEid: number | null = null;
  private engageNoProgressFrames: number = 0;
  private engageBestDistance: number = Number.POSITIVE_INFINITY;
  private engageBestHp: number = Number.POSITIVE_INFINITY;
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
  /**
   * Cumulative fog-of-war "seen" bitmap (one byte per tile, 1 = ever seen),
   * OR-accumulated from {@link FloorMap.visible} every poll. This is exactly the
   * information the minimap shows the player (HudMinimap folds each frame's FOV
   * into a persistent `visited` array the same way), so steering toward its
   * frontier — the boundary between seen and unseen tiles — is legitimate
   * exploration, not omniscience. Lazily sized on first use; `null` until then.
   */
  private exploredSeen: Uint8Array | null = null;
  /** True once FOV has exposed at least one tile this run (perception initialized). */
  private hasPerceptionData = false;
  /** Reused per-tile BFS visited scratch for {@link findNearestFrontier}; sized to the floor. */
  private frontierBfsVisited: Uint8Array | null = null;
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
  private acceptedQuestCount: number = 0;

  constructor(config: AIConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rng = new SeededRandom(this.config.seed);
    this.decision = {
      state: AIState.EXPLORE,
      targetEid: null,
      targetX: null,
      targetY: null,
      reason: 'Initializing',
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
   *   one movement target per frame. Logic is identical to the original flat
   *   selector — Retreat > Interact > Progress > LeaveSafeRoom > Engage >
   *   Collect > Hunt > Explore. Owns `this.decision` and `state.moveX/moveY`.
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
        // Priority 2: Interact with nearby NPCs
        this.buildInteractBehavior(),
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
  private endRetreat(): void {
    this.retreating = false;
    this.retreatTargetX = null;
    this.retreatTargetY = null;
  }

  private buildRetreatBehavior(): BTNode {
    return sequence(
      'Retreat',
      condition('Low Health Under Threat', (ctx) => {
        if (ctx.healthPercent >= this.config.retreatThreshold) {
          this.endRetreat();
          return false;
        }
        const threat = this.findNearestEnemy(ctx.world, ctx.playerX, ctx.playerY);
        // Hysteresis: an enemy must close to within retreatDangerRadius to START
        // a retreat, but the AI keeps retreating until the gap exceeds
        // retreatDangerRadius * RETREAT_HYSTERESIS_MULT. This stops the per-frame
        // RETREAT<->EXPLORE flip-flop seen when an enemy hovers at the boundary.
        const radius = this.retreating
          ? this.config.retreatDangerRadius * RETREAT_HYSTERESIS_MULT
          : this.config.retreatDangerRadius;
        if (!threat || threat.distance > radius) {
          this.endRetreat();
          return false;
        }
        this.retreating = true;
        ctx.blackboard['retreatThreat'] = threat;
        return true;
      }),
      action('Set Retreat State', (ctx) => {
        const threat = ctx.blackboard['retreatThreat'] as WorldTarget | undefined;
        this.decision.state = AIState.RETREAT;
        this.decision.reason = `Low health (${(ctx.healthPercent * 100).toFixed(0)}%) near threat`;
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
        if (targetIsNpc && target.distance > NPC_INTERACTION_RADIUS_FT) {
          const nearestEnemy = this.findNearestEnemy(ctx.world, ctx.playerX, ctx.playerY);
          const npcThreatRadius = Math.min(
            this.getEngageRadius(ctx.world),
            NPC_APPROACH_THREAT_RADIUS_FT,
          );
          if (nearestEnemy && nearestEnemy.distance <= npcThreatRadius) {
            const plan = this.planEngagement(ctx.world, ctx.playerX, ctx.playerY, nearestEnemy);
            this.decision.state = AIState.ENGAGE;
            this.decision.targetEid = nearestEnemy.eid;
            this.decision.targetX = plan.targetX;
            this.decision.targetY = plan.targetY;
            this.decision.reason = `Clearing nearby threat before NPC interaction — ${plan.reason}`;
            return BTStatus.SUCCESS;
          }
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
        return BTStatus.SUCCESS;
      }),
    );
  }

  /**
   * Collect behavior: gather XP gems and loot.
   */
  private buildCollectBehavior(): BTNode {
    return sequence(
      'Collect',
      condition('Loot Nearby', (ctx) => {
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
        const objective = ctx.world.floor1?.objective;
        if (
          !ctx.world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID) ||
          objective?.questCompleted === true
        ) {
          return false;
        }
        const nearest = this.findNearestEnemy(ctx.world, ctx.playerX, ctx.playerY);
        if (!nearest) {
          return false;
        }
        const engageRadius = this.getEngageRadius(ctx.world);
        if (nearest.distance <= engageRadius || nearest.distance > this.config.scanRadius) {
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
   * living enemy is within scan range, drive *past* the nearest enemy to exit
   * the safe zone. The weapon is hard-disabled inside safe rooms (weaponSystem
   * safe-space gate), so holding melee range there is a permanent stalemate and
   * the engage watchdog would otherwise blacklist the entire wave as
   * "unreachable". This outranks Engage/Collect so the AI commits to leaving
   * instead of oscillating across the boundary.
   */
  private buildLeaveSafeRoomBehavior(): BTNode {
    return sequence(
      'LeaveSafeRoom',
      condition('In Safe Room With Threat', (ctx) => {
        if (!ctx.world.playerInSafeRoom) {
          return false;
        }
        const nearest = this.findNearestEnemy(ctx.world, ctx.playerX, ctx.playerY);
        if (!nearest) {
          return false;
        }
        ctx.blackboard['safeRoomThreat'] = nearest;
        return true;
      }),
      action('Set Leave Safe Room State', (ctx) => {
        const threat = ctx.blackboard['safeRoomThreat'] as WorldTarget;
        // Overshoot past the enemy so the move target is firmly outside the safe
        // room even though the enemy itself hugs the boundary. A* clamps the
        // target to the nearest reachable tile, so this reliably steps the player
        // out where the weapon can finally fire.
        const dx = threat.x - ctx.playerX;
        const dy = threat.y - ctx.playerY;
        const len = Math.hypot(dx, dy) || 1;
        this.decision.state = AIState.ENGAGE;
        this.decision.targetEid = threat.eid;
        this.decision.targetX = threat.x + (dx / len) * SAFE_ROOM_EXIT_OVERSHOOT_FT;
        this.decision.targetY = threat.y + (dy / len) * SAFE_ROOM_EXIT_OVERSHOOT_FT;
        this.decision.reason = `Leaving safe room to engage enemy at ${threat.distance.toFixed(1)}ft`;
        return BTStatus.SUCCESS;
      }),
    );
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
   * OpportunisticDodge: inject a perpendicular strafe impulse when an enemy
   * is closing fast toward the player — OR is parked directly in its path.
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
      // Dodge is suspended during retreat (retreat kiting owns the direction),
      // during active engagement (planEngagement's kite-strike orbit is
      // precision-tuned; a 0.4-weight perpendicular injection would displace
      // the player outside weapon range and stall the fight indefinitely),
      // and during NPC interaction (mustn't deflect approach to the NPC target).
      if (
        this.decision.state === AIState.RETREAT ||
        this.decision.state === AIState.ENGAGE ||
        this.decision.state === AIState.INTERACT
      ) {
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
   * with {@link AIConfig.farmPullWeight} (default 0 = dormant). This keeps enemy
   * seeking OFF unless explicitly enabled, so turning loot detours back on never
   * silently re-introduces the over-engagement that blew the floor-clear budget.
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
      // Dormant unless a non-zero farm weight is configured; skip the enemy scan
      // entirely when the pull would be multiplied to nothing.
      if (this.config.farmPullWeight <= 0) return BTStatus.FAILURE;

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
   */
  private updateEngageWatchdog(world: GameWorld, playerX: number, playerY: number): void {
    const eid = this.decision.targetEid;
    if (this.decision.state !== AIState.ENGAGE || eid === null) {
      this.engageTargetEid = null;
      this.engageNoProgressFrames = 0;
      this.engageBestDistance = Number.POSITIVE_INFINITY;
      this.engageBestHp = Number.POSITIVE_INFINITY;
      return;
    }

    // Inside a safe room the weapon is hard-disabled, so the player can neither
    // close the final ft nor drop the enemy's HP. That is not "unreachable" —
    // the LeaveSafeRoom behavior is actively walking the player out. Resetting
    // the no-progress counter here prevents the watchdog from blacklisting the
    // entire wave (which would collapse Engage into a COLLECT wiggle deadlock).
    if (world.playerInSafeRoom) {
      this.engageTargetEid = eid;
      this.engageNoProgressFrames = 0;
      this.engageBestDistance = Number.POSITIVE_INFINITY;
      this.engageBestHp = Number.POSITIVE_INFINITY;
      return;
    }

    if (eid !== this.engageTargetEid) {
      this.engageTargetEid = eid;
      this.engageNoProgressFrames = 0;
      this.engageBestDistance = Number.POSITIVE_INFINITY;
      this.engageBestHp = Number.POSITIVE_INFINITY;
    }

    const ex = world.stores.position.x[eid];
    const ey = world.stores.position.y[eid];
    const hp = world.stores.health.current[eid];
    if (typeof ex !== 'number' || typeof ey !== 'number' || typeof hp !== 'number' || hp <= 0) {
      // Target despawned or died; let normal retargeting take over next tick.
      this.engageTargetEid = null;
      this.engageNoProgressFrames = 0;
      return;
    }

    const dist = Math.hypot(ex - playerX, ey - playerY);
    let progressed = false;
    if (dist < this.engageBestDistance - ENGAGE_PROGRESS_EPSILON_FT) {
      this.engageBestDistance = dist;
      progressed = true;
    }
    if (hp < this.engageBestHp) {
      this.engageBestHp = hp;
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
      this.engageTargetEid = null;
      this.engageNoProgressFrames = 0;
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
  private updateExploreWatchdog(playerX: number, playerY: number, currentFrame: number): void {
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
    // targetEid < 0 — e.g. Tutorial Goon, Shopkeeper, boss room), suppress ALL
    // position progress goals temporarily. Without this the BT immediately
    // re-assigns the same unreachable position on the next frame, the dwell
    // counter resets to 0, and the AI freezes forever without ever fighting.
    if (this.decision.targetEid === null || this.decision.targetEid < 0) {
      this.progressGoalSuppressedUntilFrame = currentFrame + PROGRESS_SUPPRESS_FRAMES;
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
    this.engageTargetEid = null;
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

  poll(state: InputState, world: GameWorld): void {
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
    this.updateExploreWatchdog(playerX, playerY, world.frameCount);

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

    // Fold this frame's field-of-view into the cumulative fog-of-war "seen"
    // bitmap so frontier exploration (pickExploreTarget) can steer toward unseen
    // ground. Mirrors how the minimap accumulates per-frame FOV into a persistent
    // visited array, so the AI only ever "knows" what the player has actually seen.
    this.accumulateSeenTiles(world);

    // Reset opportunistic vectors from Track B so stale data never carries over.
    this.opportunisticPullX = 0;
    this.opportunisticPullY = 0;
    this.farmPullX = 0;
    this.farmPullY = 0;
    this.dodgeVecX = 0;
    this.dodgeVecY = 0;

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

    // Execute behavior tree (Track A sets this.decision; Track B writes
    // opportunisticPullX/Y and dodgeVecX/Y as side-effects)
    this.tree.tick(context);

    // Execute decision: move toward target (Track A direction)
    if (this.decision.targetX !== null && this.decision.targetY !== null) {
      this.moveToward(state, world, playerX, playerY, this.decision.targetX, this.decision.targetY);
    } else {
      state.moveX = 0;
      state.moveY = 0;
    }

    // Blend Track B opportunistic vectors additively into the Track A direction.
    // The result is re-normalized to unit length if it exceeds 1 so the player
    // moves at full speed regardless of blend magnitudes. The loot-detour pull
    // and the (default-dormant) enemy-farm pull ride independent weights.
    const blendX =
      state.moveX +
      this.dodgeVecX * this.config.dodgeWeight +
      this.opportunisticPullX * this.config.collectPullWeight +
      this.farmPullX * this.config.farmPullWeight;
    const blendY =
      state.moveY +
      this.dodgeVecY * this.config.dodgeWeight +
      this.opportunisticPullY * this.config.collectPullWeight +
      this.farmPullY * this.config.farmPullWeight;
    const blendLen = Math.hypot(blendX, blendY);
    if (blendLen > 1) {
      state.moveX = blendX / blendLen;
      state.moveY = blendY / blendLen;
    } else {
      state.moveX = blendX;
      state.moveY = blendY;
    }

    // Smooth the output direction so waypoint transitions and kite reversals
    // produce a fluid arc rather than an instant direction snap. The blended
    // values are passed directly to playerInputSystem; normalizeInputDirection
    // keeps them unchanged when their length is ≤ 1, so the player naturally
    // accelerates/decelerates through turns at sub-full speed.
    this.smoothMoveX += (state.moveX - this.smoothMoveX) * MOVE_SMOOTH_FACTOR;
    this.smoothMoveY += (state.moveY - this.smoothMoveY) * MOVE_SMOOTH_FACTOR;
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

  private withQuestGiverDetour(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
    target: ProgressTarget,
  ): ProgressTarget {
    if (target.eid >= 0 && world.npcs.has(target.eid)) {
      return target;
    }
    const nearestNpc = this.findNearestRelevantNpc(world, playerEid, playerX, playerY);
    if (
      !nearestNpc ||
      typeof nearestNpc.interactionReason !== 'string' ||
      nearestNpc.interactionReason.length === 0
    ) {
      return target;
    }
    if (nearestNpc.eid === target.eid) {
      return target;
    }
    if (world.playerInSafeRoom && isPointInSafeSpace(world, nearestNpc.x, nearestNpc.y)) {
      const floorMap = world.floorMap;
      if (floorMap) {
        const playerTile = floorMap.worldToTile(playerX, playerY);
        const npcTile = floorMap.worldToTile(nearestNpc.x, nearestNpc.y);
        const safeRooms = floorMap.roomGraph.getRoomsByRole(RoomRole.SAFE);

        // Check if both player and NPC are in the same safe room
        let sameRoom = false;
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
            sameRoom = true;
            break;
          }
        }

        if (sameRoom) {
          const readableReason = nearestNpc.interactionReason.replaceAll('-', ' ');
          return this.createProgressTarget(
            nearestNpc.x,
            nearestNpc.y,
            playerX,
            playerY,
            `Detouring to ${nearestNpc.defId} (${readableReason})`,
            nearestNpc.eid,
          );
        }
      }
    }

    const viaNpcDistance =
      nearestNpc.distance + Math.hypot(target.x - nearestNpc.x, target.y - nearestNpc.y);
    const detourExtra = viaNpcDistance - target.distance;
    const detourCap = Math.max(
      QUEST_GIVER_DETOUR_MAX_EXTRA_FT,
      target.distance * QUEST_GIVER_DETOUR_MAX_EXTRA_FRACTION,
    );
    if (detourExtra > detourCap) {
      return target;
    }

    const readableReason = nearestNpc.interactionReason.replaceAll('-', ' ');
    return this.createProgressTarget(
      nearestNpc.x,
      nearestNpc.y,
      playerX,
      playerY,
      `Detouring to ${nearestNpc.defId} (${readableReason})`,
      nearestNpc.eid,
    );
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
    let head = 0;
    let tail = 0;
    const startIndex = startTile.y * width + startTile.x;
    dist[startIndex] = 0;
    queue[tail++] = startIndex;
    while (head < tail) {
      const index = queue[head++]!;
      const depth = dist[index]!;
      if (depth >= maxDepth) {
        continue;
      }
      const cx = index % width;
      const cy = (index - cx) / width;
      // 4-connected expansion mirrors findTilePath's topology-4 A*.
      if (cx + 1 < width && dist[index + 1] === -1 && passable(cx + 1, cy)) {
        dist[index + 1] = depth + 1;
        queue[tail++] = index + 1;
      }
      if (cx - 1 >= 0 && dist[index - 1] === -1 && passable(cx - 1, cy)) {
        dist[index - 1] = depth + 1;
        queue[tail++] = index - 1;
      }
      if (cy + 1 < height && dist[index + width] === -1 && passable(cx, cy + 1)) {
        dist[index + width] = depth + 1;
        queue[tail++] = index + width;
      }
      if (cy - 1 >= 0 && dist[index - width] === -1 && passable(cx, cy - 1)) {
        dist[index - width] = depth + 1;
        queue[tail++] = index - width;
      }
    }

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
  ): WorldTarget | null {
    const enemies = query(world.ecs, [Enemy, Position, Health]);
    const candidates: WorldTarget[] = [];

    for (const eid of enemies) {
      if (eid === undefined) continue;

      const ignoredUntil = this.ignoredEnemyUntilFrame.get(eid);
      if (ignoredUntil !== undefined) {
        if (ignoredUntil > world.frameCount) continue;
        this.ignoredEnemyUntilFrame.delete(eid);
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
   * rat/slime registered in {@link GameWorld.floor1}'s `enemyArchetypes`. Only
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
    const floor1 = world.floor1;
    if (!floor1) {
      return null;
    }

    const candidates: WorldTarget[] = [];
    for (const eid of floor1.enemyArchetypes.keys()) {
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

  private findProgressObjective(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
  ): ProgressTarget | null {
    const maybeDetourToQuestGiver = (target: ProgressTarget): ProgressTarget =>
      this.withQuestGiverDetour(world, playerEid, playerX, playerY, target);
    const floor1 = world.floor1;
    const objective = floor1?.objective;
    if (!floor1 || !objective) {
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
      if (progressSuppressed) return null;
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.welcomeOfficePos.x,
          objective.welcomeOfficePos.y,
          playerX,
          playerY,
          'Seeking Tutorial Goon to unlock the floor quest',
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

    if (shopStage === 'not-met') {
      if (progressSuppressed) return null;
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.shopRoomPos.x,
          objective.shopRoomPos.y,
          playerX,
          playerY,
          'Seeking Shopkeeper to start the merchant errand',
        ),
      );
    }

    if (shopStage === 'awaiting-prize') {
      if (progressSuppressed) return null;
      const target = hasFetchItem ? objective.shopRoomPos : objective.questItemPos;
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          target.x,
          target.y,
          playerX,
          playerY,
          hasFetchItem ? 'Returning the merchant prize' : 'Seeking the merchant fetch item',
        ),
      );
    }

    if (shopStage === 'ready-to-buy') {
      if (world.playerGold >= SHOPKEEPER_EQUIPMENT_COST) {
        if (progressSuppressed) return null;
        return maybeDetourToQuestGiver(
          this.createProgressTarget(
            objective.shopRoomPos.x,
            objective.shopRoomPos.y,
            playerX,
            playerY,
            'Returning to the Shopkeeper to buy the charm',
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
      const goldPile = this.findNearestGold(world, playerX, playerY, GOLD_FARM_GOLD_SCAN_RADIUS_FT);

      // Prefer a *nearby* pile we can realistically walk onto. The stuck handler
      // blacklists piles we get wedged against, so a deadlocked coin eventually
      // drops out of this scan and we fall through to hunting.
      if (goldPile && goldPile.distance <= GOLD_FARM_COLLECT_RADIUS_FT) {
        return maybeDetourToQuestGiver(
          this.createProgressTarget(
            goldPile.x,
            goldPile.y,
            playerX,
            playerY,
            `Collecting gold for the merchant charm (${goldOwed}g to go)`,
            goldPile.eid,
          ),
        );
      }

      // No close coin: close on the swarm so auto-fire drops fresh gold right at
      // the kill, which the branch above then sweeps up on a later tick.
      const prey = this.findNearestEnemy(world, playerX, playerY, GOLD_FARM_ENEMY_SCAN_RADIUS_FT);
      if (prey) {
        return maybeDetourToQuestGiver(
          this.createProgressTarget(
            prey.x,
            prey.y,
            playerX,
            playerY,
            `Hunting the swarm for charm gold (${goldOwed}g to go)`,
            prey.eid,
          ),
        );
      }

      // Nothing nearby to fight: a distant pile is still better than wandering.
      if (goldPile) {
        return maybeDetourToQuestGiver(
          this.createProgressTarget(
            goldPile.x,
            goldPile.y,
            playerX,
            playerY,
            `Collecting gold for the merchant charm (${goldOwed}g to go)`,
            goldPile.eid,
          ),
        );
      }

      return null;
    }

    if (!objective.questCompleted) {
      return null;
    }

    if (!bossBattleAccepted) {
      if (progressSuppressed) return null;
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.spellQuestGiverPos.x,
          objective.spellQuestGiverPos.y,
          playerX,
          playerY,
          'Seeking the Spell Broker to start the Slime Rat quest',
        ),
      );
    }

    if (!objective.bossBattles.get('slime-rat')!.started) {
      if (progressSuppressed) return null;
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.slimeRatRoomPos.x,
          objective.slimeRatRoomPos.y,
          playerX,
          playerY,
          'Heading to the Slime Rat room',
        ),
      );
    }

    if (objective.bossBattles.get('slime-rat')!.defeated && !world.featureUnlocks.spells) {
      if (progressSuppressed) return null;
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.spellQuestGiverPos.x,
          objective.spellQuestGiverPos.y,
          playerX,
          playerY,
          'Returning to the Spell Broker to claim a spell reward',
        ),
      );
    }

    if (
      objective.bossBattles.get('slime-rat')!.defeated &&
      !objective.bossBattles.get('staircase')!.started
    ) {
      if (progressSuppressed) return null;
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.staircasePos.x,
          objective.staircasePos.y,
          playerX,
          playerY,
          'Heading to the staircase boss room',
        ),
      );
    }

    if (objective.staircaseUnlocked && !objective.staircaseDiscovered) {
      if (progressSuppressed) return null;
      return maybeDetourToQuestGiver(
        this.createProgressTarget(
          objective.staircasePos.x,
          objective.staircasePos.y,
          playerX,
          playerY,
          'Heading to the stairs to clear the floor',
        ),
      );
    }

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
    };
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
   * Fold this frame's field-of-view into the cumulative "seen" fog-of-war bitmap.
   *
   * {@link FloorMap.visible} is line-of-sight only — the FOV system clears and
   * recomputes it every frame — so we OR it into {@link exploredSeen} to retain
   * everywhere the player has ever seen. This mirrors HudMinimap's `visited`
   * accumulation exactly, so the frontier search below only ever steers toward
   * ground the player could legitimately know about.
   */
  private accumulateSeenTiles(world: GameWorld): void {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return;
    }
    const W = floorMap.width;
    const H = floorMap.height;
    const tileCount = W * H;
    if (!this.exploredSeen || this.exploredSeen.length !== tileCount) {
      this.exploredSeen = new Uint8Array(tileCount);
    }
    const seen = this.exploredSeen;
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const i = ty * W + tx;
        if (!seen[i] && floorMap.isVisible(tx, ty)) {
          seen[i] = 1;
          this.hasPerceptionData = true;
        }
      }
    }
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
    const idx = tile.y * floorMap.width + tile.x;
    if (floorMap.isVisible(tile.x, tile.y)) return true;
    return this.exploredSeen?.[idx] === 1;
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
    const seen = this.exploredSeen;
    if (!floorMap || !seen) {
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
      isSeen: (idx) => seen[idx] !== 0,
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
      const path = findTilePath(floorMap, startTile, goalTile, this.groundPathOptions());
      if (path.length > 1) {
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
    if (
      weapon.weaponType === WeaponType.RANGED ||
      weapon.weaponType === WeaponType.MAGIC ||
      weapon.weaponType === WeaponType.THROWN ||
      weapon.weaponType === WeaponType.BEAM
    ) {
      return this.planRangedEngagement(world, playerX, playerY, target, reachFt);
    }

    if (weapon.weaponType !== WeaponType.MELEE) {
      return {
        targetX: target.x,
        targetY: target.y,
        reason: `Engaging enemy at distance ${target.distance.toFixed(1)}ft`,
      };
    }
    // Actual gate at which a melee swing connects (weaponSystem fires when an enemy
    // is within reach*1.5 and the cooldown has elapsed — independent of whether the
    // player is moving). Once inside it we KITE instead of parking.
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

    for (const eid of query(world.ecs, [Enemy, Position])) {
      if (eid === primaryTarget.eid) continue;
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
    // When wounded, prioritise not being hit: allow the orbit to expand all the way
    // out to the strike gate (a swing still connects out to reach*1.5) so the player
    // can sit just beyond the enemy's own attackRange and poke from safety. At healthy
    // HP we keep the tighter recover band for maximum DPS / AoE cleave.
    const defensive = this.getPlayerHealthFraction(world) < MELEE_DEFENSIVE_HP_FRACTION;
    const safeOrbitCap = defensive ? reachFt * ATTACK_GATE_MULTIPLIER : outerOrbit;
    if (enemyAttackFt > 0) {
      const safeOrbit = enemyAttackFt + KITE_DODGE_BUFFER_FT;
      if (safeOrbit <= safeOrbitCap) {
        // We can stand outside the enemy's strike range and still land hits.
        desiredOrbit = Math.min(safeOrbitCap, Math.max(desiredOrbit, safeOrbit));
      } else if (defensive) {
        // Enemy outranges our gate (e.g. a ranged boss): get as far out as the gate
        // allows rather than parking in the strike band.
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
    const desiredOrbit = Math.max(
      CONTACT_SAFE_ORBIT_FT,
      Math.min(reachFt * RANGED_STANDOFF_FRACTION, RANGED_STANDOFF_ABS_FT),
    );

    if (target.distance > desiredOrbit + RANGED_APPROACH_BUFFER_FT) {
      // Too far to orbit: navigate toward a point at the desired standoff distance
      // from the enemy so A* can plan the full route.
      const dx = target.x - playerX;
      const dy = target.y - playerY;
      const scale = (target.distance - desiredOrbit) / target.distance;
      return {
        targetX: playerX + dx * scale,
        targetY: playerY + dy * scale,
        reason: `Closing to ranged standoff (${desiredOrbit.toFixed(1)}ft) from ${target.distance.toFixed(1)}ft`,
      };
    }

    // At or inside the standoff band: orbit laterally while the radial correction
    // keeps the distance near desiredOrbit (pushing away if too close, nudging in
    // if slightly too far).
    return this.computeRangedKiteTarget(world, playerX, playerY, target, desiredOrbit);
  }

  /**
   * Ranged orbit step: move along the player-enemy axis (advance to close gap,
   * retreat when enemy pushes in) with a small lateral juke, using the same
   * orbit-sign flip infrastructure as melee kiting. Full lateral orbit activates
   * when an enemy is approaching from behind. The radial correction component
   * automatically retreats when the enemy closes in.
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

    // Prefer radial (forward/backward) motion; orbit fully only when flanked.
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
        interactionReason: interactionReason ?? '',
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
  ): string | null {
    const floor1 = world.floor1;
    if (!floor1) {
      return 'generic-interaction';
    }

    const instance = world.npcs.get(npcEid);
    if (!instance) {
      return null;
    }

    const objective = floor1.objective;
    const shopStage = getShopkeeperStage(world);
    const bag = world.inventories.get(playerEid);
    const hasFetchItem = bag ? hasItem(bag, SHOPKEEPER_FETCH_ITEM_ID) : false;

    switch (instance.defId) {
      case 'tutorial-goon':
        return world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID) ? null : 'accept-tutorial-quest';
      case 'shopkeeper':
        if (world.playerLevel.level < FLOOR1_QUEST_UNLOCK_LEVEL) {
          // The merchant errand is gated behind reaching level 2.
          return null;
        }
        if (shopStage === 'not-met') {
          return 'meet-shopkeeper';
        }
        if (shopStage === 'awaiting-prize' && hasFetchItem) {
          return 'return-shopkeeper-prize';
        }
        if (shopStage === 'ready-to-buy' && world.playerGold >= SHOPKEEPER_EQUIPMENT_COST) {
          return 'buy-shopkeeper-equipment';
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
          return 'accept-spell-quest';
        }
        if (objective.bossBattles.get('slime-rat')!.defeated && !world.featureUnlocks.spells) {
          return 'claim-spell-reward';
        }
        return null;
      default:
        return null;
    }
  }

  getDecision(): AIDecision {
    return { ...this.decision };
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

  reset(): void {
    this.decision = {
      state: AIState.EXPLORE,
      targetEid: null,
      targetX: null,
      targetY: null,
      reason: 'Reset',
    };
    this.pathWaypoints = [];
    this.pathIndex = 0;
    this.pathGoalKey = null;
    this.moveWedgeFrames = 0;
    this.moveWedgeLastX = Number.NaN;
    this.moveWedgeLastY = Number.NaN;
    this.stuckFrames = 0;
    this.ignoredLootUntilFrame.clear();
    this.ignoredEnemyUntilFrame.clear();
    this.targetReachableCache.clear();
    this.engageTargetEid = null;
    this.engageNoProgressFrames = 0;
    this.engageBestDistance = Number.POSITIVE_INFINITY;
    this.engageBestHp = Number.POSITIVE_INFINITY;
    this.collectDwellActive = false;
    this.collectDwellAnchorX = 0;
    this.collectDwellAnchorY = 0;
    this.collectDwellFrames = 0;
    this.exploreDwell.reset();
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
    this.exploredSeen = null;
    this.hasPerceptionData = false;
    this.frontierBfsVisited = null;
    this.retreating = false;
    this.retreatTargetX = null;
    this.retreatTargetY = null;
    this.retreatRepickFrame = 0;
    this.opportunisticPullX = 0;
    this.opportunisticPullY = 0;
    this.farmPullX = 0;
    this.farmPullY = 0;
    this.dodgeVecX = 0;
    this.dodgeVecY = 0;
    this.acceptedQuestCount = 0;
  }
}
