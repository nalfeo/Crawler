/**
 * Behavior Tree AI input provider.
 *
 * Industry-standard behavior tree implementation that replaces the rule-based
 * state machine with composable, maintainable behavior trees.
 */

import { query, hasComponent } from 'bitecs';
import {
  Player,
  Position,
  Health,
  Enemy,
  XpGem,
  Gold,
  DroppedItem,
  Npc,
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
import {
  buildDoorAwarePassable,
  getNavigationBlockedDoors,
  type DoorUnlockRequirement,
} from '../../core/door-navigation.js';
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
import { ftToPx } from '../../shared/units.js';
import { AIState, type AIInputProvider, type AIDecision, type AIConfig } from './types.js';
import {
  BehaviorTree,
  BTStatus,
  type BTContext,
  selector,
  sequence,
  condition,
  action,
  type BTNode,
} from './behavior-tree.js';
import { getShopkeeperStage, SHOPKEEPER_EQUIPMENT_COST } from '../floor1Scenario.js';
import { getActiveWeapon } from '../weaponSystem.js';

const logger = createLogger('game:bt-ai-provider');

const DEFAULT_CONFIG: Required<AIConfig> = {
  seed: 12345,
  aggression: 1,
  retreatThreshold: 0.3,
  scanRadius: 400,
  rangedSafeDistance: 120,
  debug: false,
};

const DIRECT_MOVE_EPSILON_PX = 10;
const MELEE_APPROACH_BUFFER_PX = 8;
const NAVIGATION_LOOKAHEAD_PX = 24;
const PATH_GOAL_SEARCH_RADIUS_TILES = 6;
const STUCK_PROGRESS_EPSILON_PX = 4;
const NAVIGATION_MAX_PATH_LENGTH = 1_024;
// How long (frames) to ignore an enemy after abandoning it as unreachable.
const ENEMY_IGNORE_FRAMES = 240;
// Minimum px the gap to a target enemy must close to count as engagement progress.
const ENGAGE_PROGRESS_EPSILON_PX = 6;
// Frames of no distance/HP progress against the same enemy before we abandon it.
const ENGAGE_GIVEUP_FRAMES = 120;
// How long (frames) a per-enemy reachability result is reused before recomputing.
// Player movement changes reachability slowly (~3px/frame), so a short TTL keeps
// the A* cost bounded without noticeably lagging behind door/room openings.
const REACHABILITY_CACHE_TTL_FRAMES = 20;
// Radius (tiles) searched for a pathable approach tile when an enemy's exact
// tile is blocked (e.g. it stands against a wall). Mirrors how movement resolves
// a goal tile so the reachability gate doesn't reject enemies we can actually reach.
const REACHABILITY_GOAL_SEARCH_RADIUS_TILES = 2;
const NAVIGATION_ANGLE_OFFSETS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2] as const;

type LootKind = 'xp' | 'gold' | 'item';

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

export interface AILockedDoorMemory {
  eid: number;
  tileX: number;
  tileY: number;
  unlockRequirement: DoorUnlockRequirement;
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
  private pathWaypoints: TilePoint[] = [];
  private pathIndex: number = 0;
  private pathGoalKey: string | null = null;
  private stuckFrames: number = 0;
  private lastPlayerX: number = 0;
  private lastPlayerY: number = 0;
  private readonly ignoredLootUntilFrame = new Map<number, number>();
  private readonly ignoredEnemyUntilFrame = new Map<number, number>();
  private engageTargetEid: number | null = null;
  private engageNoProgressFrames: number = 0;
  private engageBestDistance: number = Number.POSITIVE_INFINITY;
  private engageBestHp: number = Number.POSITIVE_INFINITY;
  private readonly enemyReachableCache = new Map<number, { frame: number; reachable: boolean }>();
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
   * Locked doors the AI is currently aware of, keyed by door entity. Populated
   * from {@link getNavigationBlockedDoors} each poll and pruned when a door's
   * unlock condition is satisfied, so it reflects "doors I know I cannot yet
   * pass, and what each needs".
   */
  private readonly knownLockedDoors = new Map<number, AILockedDoorMemory>();

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
   * Priority: Retreat > Interact > Collect > Engage > Explore
   */
  private buildTree(): BehaviorTree {
    const root = selector(
      'AI Root',
      // Priority 1: Retreat when low health
      this.buildRetreatBehavior(),
      // Priority 2: Interact with nearby NPCs
      this.buildInteractBehavior(),
      // Priority 3: Engage enemies
      this.buildEngageBehavior(),
      // Priority 4: Collect nearby loot
      this.buildCollectBehavior(),
      // Priority 5: Close distance to nearby enemies before wandering off
      this.buildHuntBehavior(),
      // Priority 6: Seek progression objectives
      this.buildProgressBehavior(),
      // Priority 7: Explore when nothing else to do
      this.buildExploreBehavior(),
    );

    return new BehaviorTree(root);
  }

  /**
   * Retreat behavior: flee when health is low.
   */
  private buildRetreatBehavior(): BTNode {
    return sequence(
      'Retreat',
      condition('Low Health', (ctx) => ctx.healthPercent < this.config.retreatThreshold),
      action('Set Retreat State', (ctx) => {
        this.decision.state = AIState.RETREAT;
        this.decision.reason = `Low health (${(ctx.healthPercent * 100).toFixed(0)}%)`;
        this.decision.targetX = ctx.playerX;
        this.decision.targetY = ctx.playerY;
        this.decision.targetEid = null;
        // TODO: Find nearest safe room
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
        if (nearest && nearest.distance < 100) {
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
        this.decision.reason = `Interacting with ${nearest.defId} (${nearest.interactionReason}) at ${nearest.distance.toFixed(0)}px`;
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
        this.decision.reason = `Collecting ${nearest.kind} at distance ${nearest.distance.toFixed(0)}px`;
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
        this.decision.reason = `Hunting enemy at distance ${nearest.distance.toFixed(0)}px`;
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
          if (dist < 50) {
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
    if (dist < this.engageBestDistance - ENGAGE_PROGRESS_EPSILON_PX) {
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

    // Update stuck detection
    const dist = Math.hypot(playerX - this.lastPlayerX, playerY - this.lastPlayerY);
    if (dist < STUCK_PROGRESS_EPSILON_PX) {
      this.stuckFrames++;
    } else {
      this.stuckFrames = 0;
    }
    this.lastPlayerX = playerX;
    this.lastPlayerY = playerY;

    // If stuck for too long, clear path and pick new goal. NOTE: stuckFrames is
    // a weak signal — at ~3px/frame normal travel it can climb even while moving
    // productively, so enemy abandonment is handled by updateEngageWatchdog
    // (real distance/HP progress) rather than here. We only blacklist loot here.
    if (this.stuckFrames > 60) {
      if (this.decision.state === AIState.COLLECT && this.decision.targetEid !== null) {
        this.ignoredLootUntilFrame.set(this.decision.targetEid, world.frameCount + 300);
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

    // Refresh door-aware navigation each poll: closed-but-openable doors become
    // passable for A*, while locked-unsatisfied doors stay walls. Rebuilding
    // here picks up unlock conditions the player has just satisfied.
    this.refreshDoorNavigation(world);

    // Build context for behavior tree
    const context: BTContext = {
      world,
      playerEid,
      playerX,
      playerY,
      healthPercent,
      blackboard: {},
    };

    // Execute behavior tree
    this.tree.tick(context);

    // Execute decision: move toward target
    if (this.decision.targetX !== null && this.decision.targetY !== null) {
      this.moveToward(state, world, playerX, playerY, this.decision.targetX, this.decision.targetY);
    } else {
      state.moveX = 0;
      state.moveY = 0;
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

  /**
   * Rebuild the door-aware passability predicate and refresh locked-door memory.
   * Called once per poll so pathfinding reflects the current lock state.
   */
  private refreshDoorNavigation(world: GameWorld): void {
    this.doorAwarePassable = world.floorMap ? buildDoorAwarePassable(world) : null;

    const blocked = getNavigationBlockedDoors(world);
    const blockedEids = new Set<number>();
    for (const info of blocked) {
      blockedEids.add(info.eid);
      this.knownLockedDoors.set(info.eid, {
        eid: info.eid,
        tileX: info.tileX,
        tileY: info.tileY,
        unlockRequirement: info.unlockRequirement,
      });
    }
    // Forget doors whose unlock condition is now satisfied; they are passable.
    for (const eid of [...this.knownLockedDoors.keys()]) {
      if (!blockedEids.has(eid)) {
        this.knownLockedDoors.delete(eid);
      }
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

    if (distance < DIRECT_MOVE_EPSILON_PX) {
      // Close enough - stop moving
      state.moveX = 0;
      state.moveY = 0;
      return;
    }

    const floorMap = world.floorMap;
    if (floorMap) {
      const startTile = floorMap.pixelToTile(playerX, playerY);
      const goalTile = floorMap.pixelToTile(targetX, targetY);
      const resolvedGoal = this.resolveReachableGoalTile(floorMap, startTile, goalTile);
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
      const waypoint = this.pathWaypoints[this.pathIndex];
      if (!waypoint) {
        this.pathWaypoints = [];
        this.pathIndex = 0;
        this.pathGoalKey = null;
      } else {
        const waypointWorld = floorMap ? floorMap.tileToPixel(waypoint.x, waypoint.y) : null;
        if (!waypointWorld) {
          this.pathWaypoints = [];
          this.pathIndex = 0;
          this.pathGoalKey = null;
          return;
        }
        const waypointDist = Math.hypot(playerX - waypointWorld.x, playerY - waypointWorld.y);

        if (waypointDist < 8) {
          // Reached waypoint - move to next
          this.pathIndex++;
          if (this.pathIndex >= this.pathWaypoints.length) {
            this.pathWaypoints = [];
            this.pathIndex = 0;
            this.pathGoalKey = null;
          }
        } else {
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

    // Fallback: direct movement toward target
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
    const directPath = findTilePath(floorMap, startTile, goalTile, this.groundPathOptions());
    if (directPath.length > 1) {
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
          if (!floorMap.tileMap.inBounds(candidate.x, candidate.y)) {
            continue;
          }
          if (!floorMap.tileMap.isPassable(candidate.x, candidate.y)) {
            continue;
          }

          const path = findTilePath(floorMap, startTile, candidate, this.groundPathOptions());
          if (path.length <= 1) {
            continue;
          }

          const distanceScore = Math.abs(dx) + Math.abs(dy);
          if (
            path.length < bestPathLength ||
            (path.length === bestPathLength && distanceScore < bestDistanceScore)
          ) {
            bestGoal = candidate;
            bestPathLength = path.length;
            bestDistanceScore = distanceScore;
          }
        }
      }
    }

    return bestGoal ?? goalTile;
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
        const sampleX = playerX + candidateX * NAVIGATION_LOOKAHEAD_PX;
        const sampleY = playerY + candidateY * NAVIGATION_LOOKAHEAD_PX;
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

  private findNearestEnemy(world: GameWorld, playerX: number, playerY: number): WorldTarget | null {
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

      const dist = Math.hypot(x - playerX, y - playerY);
      if (dist <= this.config.scanRadius) {
        candidates.push({ eid, x, y, distance: dist });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);

    // Return the nearest enemy we can actually path to. Skipping unreachable
    // enemies (e.g. behind walls or in an unopened room) lets the behavior tree
    // fall through to Explore, which A*-routes to a reachable area instead of
    // local-navigating straight into a wall and wiggling forever.
    for (const candidate of candidates) {
      if (candidate.distance <= DIRECT_MOVE_EPSILON_PX) {
        return candidate;
      }
      if (this.isEnemyReachable(world, playerX, playerY, candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Whether the player can A*-path to the given enemy from its current position.
   * Results are cached per enemy for a short window to bound pathfinding cost,
   * since this is consulted from multiple behavior-tree conditions each frame.
   */
  private isEnemyReachable(
    world: GameWorld,
    playerX: number,
    playerY: number,
    target: WorldTarget,
  ): boolean {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return true;
    }

    const cached = this.enemyReachableCache.get(target.eid);
    if (cached && world.frameCount - cached.frame < REACHABILITY_CACHE_TTL_FRAMES) {
      return cached.reachable;
    }

    const startTile = floorMap.pixelToTile(playerX, playerY);
    const goalTile = floorMap.pixelToTile(target.x, target.y);
    let reachable: boolean;
    if (startTile.x === goalTile.x && startTile.y === goalTile.y) {
      reachable = true;
    } else {
      // Match movement's goal resolution: an enemy whose exact tile is blocked
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

    this.enemyReachableCache.set(target.eid, { frame: world.frameCount, reachable });
    return reachable;
  }

  private findProgressObjective(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
  ): ProgressTarget | null {
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

    if (!tutorialAccepted) {
      return this.createProgressTarget(
        objective.welcomeOfficePos.x,
        objective.welcomeOfficePos.y,
        playerX,
        playerY,
        'Seeking Tutorial Goon to unlock the floor quest',
      );
    }

    if (world.playerLevel.level < 2 || !objective.questCompleted) {
      return null;
    }

    if (shopStage === 'not-met') {
      return this.createProgressTarget(
        objective.shopRoomPos.x,
        objective.shopRoomPos.y,
        playerX,
        playerY,
        'Seeking Shopkeeper to start the merchant errand',
      );
    }

    if (shopStage === 'awaiting-prize') {
      const target = hasFetchItem ? objective.shopRoomPos : objective.questItemPos;
      return this.createProgressTarget(
        target.x,
        target.y,
        playerX,
        playerY,
        hasFetchItem ? 'Returning the merchant prize' : 'Seeking the merchant fetch item',
      );
    }

    if (shopStage === 'ready-to-buy') {
      if (world.playerGold >= SHOPKEEPER_EQUIPMENT_COST) {
        return this.createProgressTarget(
          objective.shopRoomPos.x,
          objective.shopRoomPos.y,
          playerX,
          playerY,
          'Returning to the Shopkeeper to buy the charm',
        );
      }
      return null;
    }

    if (!objective.questCompleted) {
      return null;
    }

    if (!bossBattleAccepted) {
      return this.createProgressTarget(
        objective.spellQuestGiverPos.x,
        objective.spellQuestGiverPos.y,
        playerX,
        playerY,
        'Seeking the Spell Broker to start the Slime Rat quest',
      );
    }

    if (!objective.slimeRatBattleStarted) {
      return this.createProgressTarget(
        objective.slimeRatRoomPos.x,
        objective.slimeRatRoomPos.y,
        playerX,
        playerY,
        'Heading to the Slime Rat room',
      );
    }

    if (objective.slimeRatBossDefeated && !world.featureUnlocks.spells) {
      return this.createProgressTarget(
        objective.spellQuestGiverPos.x,
        objective.spellQuestGiverPos.y,
        playerX,
        playerY,
        'Returning to the Spell Broker to claim a spell reward',
      );
    }

    if (objective.slimeRatBossDefeated && !objective.bossBattleStarted) {
      return this.createProgressTarget(
        objective.staircasePos.x,
        objective.staircasePos.y,
        playerX,
        playerY,
        'Heading to the staircase boss room',
      );
    }

    if (objective.staircaseUnlocked && !objective.staircaseDiscovered) {
      return this.createProgressTarget(
        objective.staircasePos.x,
        objective.staircasePos.y,
        playerX,
        playerY,
        'Heading to the stairs to clear the floor',
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
  ): ProgressTarget {
    return {
      eid: -1,
      x,
      y,
      distance: Math.hypot(x - playerX, y - playerY),
      reason,
    };
  }

  private getEngageRadius(world: GameWorld): number {
    const weapon = getActiveWeapon(world);
    if (!weapon) {
      return this.config.scanRadius * 0.4;
    }

    const reachPx = ftToPx(Math.max(weapon.range, weapon.aoeRadius));
    if (weapon.weaponType === WeaponType.MELEE) {
      return Math.max(reachPx * 4, 160);
    }

    return Math.min(this.config.scanRadius, Math.max(reachPx, this.config.rangedSafeDistance * 2));
  }

  private findNearestLoot(world: GameWorld, playerX: number, playerY: number): LootTarget | null {
    const stickyLoot = this.resolveStickyLootTarget(world, playerX, playerY);
    if (stickyLoot) {
      return stickyLoot;
    }

    let nearest: LootTarget | null = null;
    let minDist = this.config.scanRadius;

    const candidates: Array<{ kind: LootKind; entities: ReturnType<typeof query> }> = [
      { kind: 'xp', entities: query(world.ecs, [XpGem, Position]) },
      { kind: 'gold', entities: query(world.ecs, [Gold, Position]) },
      { kind: 'item', entities: query(world.ecs, [DroppedItem, Position]) },
    ];

    for (const candidate of candidates) {
      for (const eid of candidate.entities) {
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

        if (dist < minDist) {
          minDist = dist;
          nearest = { eid, x, y, distance: dist, kind: candidate.kind };
        }
      }
    }

    return nearest;
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
    if (!isXp && !isGold && !isItem) {
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
      kind: isXp ? 'xp' : isGold ? 'gold' : 'item',
    };
  }

  private pickExploreTarget(
    world: GameWorld,
    playerX: number,
    playerY: number,
  ): { x: number; y: number } {
    const floorMap = world.floorMap;
    if (!floorMap) {
      const angle = this.rng.next() * Math.PI * 2;
      const distance = 200 + this.rng.next() * 200;
      return {
        x: playerX + Math.cos(angle) * distance,
        y: playerY + Math.sin(angle) * distance,
      };
    }

    if (floorMap.rooms.length > 0) {
      for (let attempt = 0; attempt < 24; attempt += 1) {
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
        const candidate = floorMap.tileToPixel(tx, ty);
        if (floorMap.isPassableAt(candidate.x, candidate.y)) {
          return candidate;
        }
      }
    }

    for (let attempt = 0; attempt < 32; attempt += 1) {
      const tx = this.rng.nextInt(1, Math.max(1, floorMap.width - 2));
      const ty = this.rng.nextInt(1, Math.max(1, floorMap.height - 2));
      const candidate = floorMap.tileToPixel(tx, ty);
      if (floorMap.isPassableAt(candidate.x, candidate.y)) {
        return candidate;
      }
    }

    return { x: playerX, y: playerY };
  }

  private planEngagement(
    world: GameWorld,
    playerX: number,
    playerY: number,
    target: WorldTarget,
  ): { targetX: number; targetY: number; reason: string } {
    const weapon = getActiveWeapon(world);
    if (!weapon || weapon.weaponType !== WeaponType.MELEE) {
      return {
        targetX: target.x,
        targetY: target.y,
        reason: `Engaging enemy at distance ${target.distance.toFixed(0)}px`,
      };
    }

    const reachPx = ftToPx(Math.max(weapon.range, weapon.aoeRadius));
    const desiredDistancePx = Math.max(DIRECT_MOVE_EPSILON_PX, reachPx - MELEE_APPROACH_BUFFER_PX);
    if (target.distance <= desiredDistancePx) {
      return {
        targetX: playerX,
        targetY: playerY,
        reason: `Holding melee range (${(reachPx / 8).toFixed(1)}ft) on enemy at ${target.distance.toFixed(0)}px`,
      };
    }

    const deltaX = target.x - playerX;
    const deltaY = target.y - playerY;
    const scale = (target.distance - desiredDistancePx) / target.distance;
    return {
      targetX: playerX + deltaX * scale,
      targetY: playerY + deltaY * scale,
      reason: `Closing to melee range (${(reachPx / 8).toFixed(1)}ft) from ${target.distance.toFixed(0)}px`,
    };
  }

  private findNearestRelevantNpc(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
  ): NpcTarget | null {
    const npcs = query(world.ecs, [Npc, Position]);
    let nearest: NpcTarget | null = null;
    let minDist = this.config.scanRadius;

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
      if (!interactionReason) {
        continue;
      }

      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      const dist = Math.hypot(x - playerX, y - playerY);

      if (dist < minDist) {
        minDist = dist;
        nearest = {
          eid,
          x,
          y,
          distance: dist,
          defId: instance.defId,
          interactionReason,
        };
      }
    }

    return nearest;
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
        if (!world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)) {
          return 'accept-spell-quest';
        }
        if (objective.slimeRatBossDefeated && !world.featureUnlocks.spells) {
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
    this.stuckFrames = 0;
    this.ignoredLootUntilFrame.clear();
    this.ignoredEnemyUntilFrame.clear();
    this.enemyReachableCache.clear();
    this.engageTargetEid = null;
    this.engageNoProgressFrames = 0;
    this.engageBestDistance = Number.POSITIVE_INFINITY;
    this.engageBestHp = Number.POSITIVE_INFINITY;
    this.discoveredNpcDefs.clear();
    this.talkedNpcDefs.clear();
    this.neededInteractionReasonByNpc.clear();
    this.doorAwarePassable = null;
    this.knownLockedDoors.clear();
  }
}
