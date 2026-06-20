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
import { getActiveWeapon, getActiveWeaponReadiness } from '../weaponSystem.js';

const logger = createLogger('game:bt-ai-provider');

const DEFAULT_CONFIG: Required<AIConfig> = {
  seed: 12345,
  aggression: 1,
  retreatThreshold: 0.15,
  retreatDangerRadius: 160,
  scanRadius: 400,
  rangedSafeDistance: 120,
  debug: false,
};

const DIRECT_MOVE_EPSILON_PX = 10;
const MELEE_APPROACH_BUFFER_PX = 8;
// --- Melee kiting (stutter-step orbit) ---
// When in melee, the player must NOT park on the enemy and trade blows. Instead
// it orbits the target inside its own weapon strike gate (so swings still land —
// melee auto-fires on proximity+cooldown regardless of player velocity) while
// continuously strafing tangentially so it stays a moving, dodging target.
// Outer edge of the reliable strike band as a fraction of the raw weapon reach.
// The fire gate is reach*1.5; orbiting at reach (1.0x) keeps swings landing with
// margin while maximizing standoff distance for dodging.
// Matches weaponSystem's ATTACK_TARGET_GATE_MULTIPLIER: a melee swing connects out
// to reach*1.5, so this is the outer radius at which kiting can still land hits.
const ATTACK_GATE_MULTIPLIER = 1.5;
// Extra px held beyond a (smaller-than-reach) enemy's own attackRange when we can
// safely poke from outside its strike range. Ignored for long-range bosses whose
// attackRange dwarfs our reach (geometrically impossible to outrange).
const KITE_DODGE_BUFFER_PX = 14;
// Per-step orbit travel target distance. Small (< CLOSE_APPROACH_DIRECT_PX) so the
// move primitive's close-approach branch drives it with obstacle-sliding local
// navigation instead of tile A*, yielding smooth strafing rather than wiggle.
const KITE_STEP_PX = 28;
// Max radial correction blended per step toward the desired orbit radius. Keeping
// this below KITE_STEP_PX makes motion mostly tangential (orbit) with gentle
// radius keeping, so the player circles instead of lunging in and out.
const KITE_RADIAL_STEP_PX = 16;
// Frames between deterministic orbit-direction flips (~2.2s at 60fps). Periodic
// reversal keeps the player juking and prevents it from grinding into one wall
// forever; far longer than any oscillation so it reads as intentional kiting.
const KITE_FLIP_FRAMES = 132;
const NAVIGATION_LOOKAHEAD_PX = 24;
// Close-range direct approach threshold (~1.5 tiles). Within this distance, and
// with a clear straight corridor, the AI abandons tile-granular A* and slides
// straight at the exact target pixel. Tile A* targets tile CENTERS and cannot
// step the 24px player body onto an 8px pickup; resolveReachableGoalTile also
// diverts to an adjacent tile whenever the target sits in the player's own tile
// (same-tile A* is trivial), producing the walk-away/walk-back "wiggling on
// pickups" oscillation. Direct approach drives the body to physically overlap
// the pickup (AABB overlap fires within 16px/axis) so collision collects it.
const CLOSE_APPROACH_DIRECT_PX = 48;
// Step (px) used to sample the corridor for hasClearLineOfSight. Half a tile so
// a wall tile between the player and target cannot be skipped over.
const LINE_OF_SIGHT_SAMPLE_PX = 8;
// Wedge recovery for path-following: if the player is aiming at a waypoint but
// collision keeps it from advancing more than MOVE_WEDGE_PROGRESS_PX per frame
// for MOVE_WEDGE_FRAMES straight frames, it is wedged on a choke/corner (e.g. a
// doorway into the boss room). Skip the stuck waypoint and hand off to
// obstacle-sliding local navigation so it threads the gap instead of vibrating
// 13px short of the goal forever (observed seed 3 freezing 160s at a boss door).
const MOVE_WEDGE_PROGRESS_PX = 1.5;
const MOVE_WEDGE_FRAMES = 24;
const PATH_GOAL_SEARCH_RADIUS_TILES = 6;
const STUCK_PROGRESS_EPSILON_PX = 4;
const NAVIGATION_MAX_PATH_LENGTH = 1_024;
// How long (frames) to ignore an enemy after abandoning it as unreachable.
const ENEMY_IGNORE_FRAMES = 240;
// Minimum px the gap to a target enemy must close to count as engagement progress.
const ENGAGE_PROGRESS_EPSILON_PX = 6;
// Frames of no distance/HP progress against the same enemy before we abandon it.
const ENGAGE_GIVEUP_FRAMES = 120;
// Frames of no distance progress toward a COLLECT loot target before we abandon
// it. Retained for the engage watchdog's epsilon reuse; the COLLECT deadlock is
// handled by the dwell watchdog below.
// How many frames an unreachable loot pile stays blacklisted once abandoned.
const LOOT_IGNORE_FRAMES = 300;
// COLLECT dwell watchdog: the per-target distance watchdog is defeated when the
// AI rotates between several mutually-unreachable gems clustered together — each
// target switch resets the per-target counter before it can fire. Instead we
// track the player's NET displacement while continuously in COLLECT. If the
// player stays parked inside a small circle for too long (wiggling against a wall
// chasing an unreachable cluster), we blacklist every loot pile in that circle at
// once so the tree falls through to Hunt/Explore.
// Net px the player must travel from the dwell anchor to count as real progress.
const COLLECT_DWELL_ESCAPE_PX = 64;
// Frames parked inside the dwell circle (no net escape) before we give up.
const COLLECT_DWELL_FRAMES = 180;
// Radius (px) around the parked player whose loot is blacklisted as unreachable.
const COLLECT_DWELL_CLUSTER_RADIUS_PX = 96;
// EXPLORE dwell watchdog: pickExploreTarget chooses a random passable tile and the
// Explore node only re-picks once the player gets within 50px of it. If that tile
// is unreachable (behind a locked door, across an unpathable gap), the player
// wiggles against the obstacle forever without ever re-picking — the per-frame
// stuck counter is defeated by the same wiggle that keeps net displacement above
// its epsilon. So we track NET displacement while continuously in EXPLORE and, if
// the player never escapes a small circle, force a fresh explore target.
// Net px the player must travel from the dwell anchor to count as real progress.
const EXPLORE_DWELL_ESCAPE_PX = 64;
// Frames parked inside the dwell circle before we force a new explore target.
const EXPLORE_DWELL_FRAMES = 180;
// EXPLORE reachability sampling: the dwell watchdog stops the AI wiggling against
// a single unreachable frontier forever, but if pickExploreTarget keeps re-rolling
// random passable tiles that happen to be unreachable from the player's current
// pocket, the AI parks in place re-rolling endlessly (only the symptom changes
// from one long wiggle to many short ones). The cure is to A*-verify candidates
// and only ever hand the Explore node a reachable target, biased toward distant
// ones to maximise new ground revealed.
// Random passable tiles to sample per explore re-pick before giving up on A*.
const EXPLORE_REACHABLE_SAMPLE_ATTEMPTS = 40;
// Reachable candidates to gather before stopping the sample sweep early.
const EXPLORE_REACHABLE_SAMPLE_TARGET = 6;
// Among the farthest reachable candidates, randomly pick from this many so the AI
// does not oscillate deterministically between two fixed extremes.
const EXPLORE_FAR_CANDIDATE_POOL = 3;
// FRONTIER exploration: the random far-tile sampler above ping-pongs between
// already-seen corners, so an objective in an unentered room is only found by
// luck (observed: Shopkeeper not discovered until ~194s on seed 3, burning the
// 300s floor-collapse budget). Instead the AI keeps a cumulative fog-of-war
// "seen" bitmap (the same data the minimap shows) and steers toward the nearest
// frontier — a seen, reachable tile adjacent to an unseen tile — which sweeps the
// map outward systematically and reveals new rooms (and the NPCs in them) far
// sooner. A door into an unexplored room is itself a frontier, so this also
// satisfies the "prioritise uncovering doors" intent. The random sampler is kept
// as a fallback for when nothing unseen remains reachable.
//
// Cap on tiles expanded by the frontier BFS per re-pick, so a fully-open floor
// cannot make the search unbounded. A re-pick only happens when the player nears
// its current target (~every 1-2s) or a watchdog clears it, so this is cheap.
const EXPLORE_FRONTIER_BFS_MAX_TILES = 8_192;
// Only return frontier targets at least this far from the player. The Explore
// behavior re-picks within 50px, so a closer target would thrash without moving;
// requiring real travel guarantees the fog (and thus the frontier set) changes
// between picks, which structurally prevents a zero-progress lock-on.
const EXPLORE_FRONTIER_MIN_PX = 80;
// GLOBAL dwell watchdog: the per-state dwell watchdogs (engage/collect/explore)
// each reset the instant their state stops running, so they structurally cannot
// catch CROSS-STATE thrash. When the behavior tree flip-flops between two states
// every single frame — e.g. an enemy that oscillates A*-reachable/unreachable as
// the player wiggles a few px across a tile edge at a doorway choke, alternating
// ENGAGE (chase the enemy one way) with COLLECT (grab loot the other way) — each
// switch zeroes the other state's counter, none ever accumulate, and the player
// vibrates in place with zero net progress forever (observed: 400s+ frozen). This
// state-agnostic watchdog runs every poll and only forgives genuine progress
// (net travel, closing on the nearest enemy, or damaging the local wave).
// Net px the player must travel from the dwell anchor to count as real progress.
const GLOBAL_DWELL_ESCAPE_PX = 96;
// Frames wedged with no progress of any kind before we force a relocation. Set
// longer than the per-state nets (180f) so those fire first whenever they apply;
// this only catches the cross-state thrash they cannot.
const GLOBAL_DWELL_FRAMES = 300;
// Px the gap to the nearest reachable enemy must close to count as approach
// progress (mirrors the engage watchdog's epsilon, slightly looser).
const GLOBAL_DWELL_ENEMY_PROGRESS_PX = 8;
// How far (px) beyond the nearest enemy the leave-safe-room move target is placed.
// The weapon is disabled inside safe rooms, so the AI must decisively exit rather
// than nudge a few px against the boundary. Sized larger than a tile (32px) so the
// clamped A* goal lands outside the safe-room rect even when the enemy hugs it.
const SAFE_ROOM_EXIT_OVERSHOOT_PX = 96;
// How long (frames) a per-enemy reachability result is reused before recomputing.
// Player movement changes reachability slowly (~3px/frame), so a short TTL keeps
// the A* cost bounded without noticeably lagging behind door/room openings.
const REACHABILITY_CACHE_TTL_FRAMES = 20;
// Radius (tiles) searched for a pathable approach tile when an enemy's exact
// tile is blocked (e.g. it stands against a wall). Mirrors how movement resolves
// a goal tile so the reachability gate doesn't reject enemies we can actually reach.
const REACHABILITY_GOAL_SEARCH_RADIUS_TILES = 2;
const NAVIGATION_ANGLE_OFFSETS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2] as const;
// Hysteresis for the retreat latch: an enemy must close to within
// retreatDangerRadius to START a retreat, but the AI keeps retreating until the
// gap exceeds retreatDangerRadius * this multiplier. Without this, an enemy
// hovering exactly at the danger boundary makes the AI flip-flop between RETREAT
// and its progression behavior every frame (observed: ~90k flips/run).
const RETREAT_HYSTERESIS_MULT = 1.5;

// Retreat kiting: when fleeing, the AI samples an arc of candidate flee
// directions around the "away from the swarm centroid" base angle, at two
// distances, and picks the most open tile it can actually A*-reach. This
// replaces the old naive single away-from-nearest-threat vector, which pointed
// straight into the wall whenever the player was cornered — navigation then
// found no reachable tile and the player wiggled in place while the swarm killed
// it (the seed-3 boss-fight death). Offsets are in radians; the mirrored set
// spans ±120° in 30° steps (9 directions).
const RETREAT_ARC_OFFSETS_RAD = [
  0,
  Math.PI / 6,
  -Math.PI / 6,
  Math.PI / 3,
  -Math.PI / 3,
  Math.PI / 2,
  -Math.PI / 2,
  (2 * Math.PI) / 3,
  -(2 * Math.PI) / 3,
] as const;
// Sample each arc direction at full and half scan radius so a reachable target
// exists even in tight rooms where the far ring is all walls.
const RETREAT_DISTANCE_MULTS = [1, 0.5] as const;
// Only enemies within this radius shape the flee centroid and the open-space
// score; distant mobs should not bias the escape direction.
const RETREAT_THREAT_SCAN_PX = 600;
// Cap A* verifications per re-pick so the arc scan stays cheap even with the
// full 18-candidate grid.
const RETREAT_MAX_PATH_VERIFICATIONS = 6;
// The kite target is recomputed at most this often (frames) — or sooner when the
// AI has no target or has arrived near the current one — keeping the bounded A*
// calls to roughly three re-picks per second instead of one per frame.
const RETREAT_REPICK_INTERVAL_FRAMES = 18;
const RETREAT_REPICK_ARRIVE_PX = 80;

// When the player still owes gold for the merchant charm, the AI actively farms
// the ambient swarm instead of wandering. These scan radii are deliberately
// wider than the default scanRadius so the AI walks toward the swarm/gold across
// a room rather than treating "no enemy within 400px" as "nothing to do" and
// exploring away from the very enemies that drop the gold it needs.
const GOLD_FARM_ENEMY_SCAN_RADIUS_PX = 1200;
const GOLD_FARM_GOLD_SCAN_RADIUS_PX = 800;
// Only divert to an already-dropped gold pile when it is this close; a pile
// farther than this is more cheaply earned by hunting the swarm (which drops
// fresh coins right next to the kill) than by trekking across the room toward a
// single pile that may have rolled into an unreachable spot. Sized a little
// larger than the melee engage hold (~160px) so coins dropped at a kill site are
// still swept up on the next tick.
const GOLD_FARM_COLLECT_RADIUS_PX = 260;

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
  private moveWedgeFrames: number = 0;
  private moveWedgeLastX: number = Number.NaN;
  private moveWedgeLastY: number = Number.NaN;
  private stuckFrames: number = 0;
  private lastPlayerX: number = 0;
  private lastPlayerY: number = 0;
  /**
   * Whether the AI is currently committed to a retreat. Latched so the retreat
   * condition can apply hysteresis (see {@link RETREAT_HYSTERESIS_MULT}) instead
   * of re-deciding every frame at the danger-radius boundary.
   */
  private retreating: boolean = false;
  /**
   * Cached kite-retreat destination (pixel center of a reachable open tile) plus
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
  private exploreDwellActive: boolean = false;
  private exploreDwellAnchorX: number = 0;
  private exploreDwellAnchorY: number = 0;
  private exploreDwellFrames: number = 0;
  /**
   * Cumulative fog-of-war "seen" bitmap (one byte per tile, 1 = ever seen),
   * OR-accumulated from {@link FloorMap.visible} every poll. This is exactly the
   * information the minimap shows the player (HudMinimap folds each frame's FOV
   * into a persistent `visited` array the same way), so steering toward its
   * frontier — the boundary between seen and unseen tiles — is legitimate
   * exploration, not omniscience. Lazily sized on first use; `null` until then.
   */
  private exploredSeen: Uint8Array | null = null;
  /** Reused per-tile BFS visited scratch for {@link findNearestFrontier}; sized to the floor. */
  private frontierBfsVisited: Uint8Array | null = null;
  private globalDwellActive: boolean = false;
  private globalDwellAnchorX: number = 0;
  private globalDwellAnchorY: number = 0;
  private globalDwellFrames: number = 0;
  private globalDwellBestEnemyDist: number = Number.POSITIVE_INFINITY;
  private globalDwellBestEnemyHp: number = Number.POSITIVE_INFINITY;
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
      // Priority 3: Seek progression objectives.
      //
      // Progress deliberately outranks Engage/Collect/Hunt. This is a
      // survivors-style game: weapons auto-fire at the nearest enemy in reach
      // regardless of the AI's movement target (see weaponSystem), so the AI
      // deals damage *while walking toward an objective* and never needs to
      // stop and fully commit to a fight. The floor also runs an ambient
      // spawner that keeps ~14 enemies on the player at all times, so the room
      // can never be "cleared" — standing still to Engage just maximises chip
      // damage with no health regen. Beelining objectives (and letting
      // auto-fire mow a path) minimises swarm dwell time and attrition.
      //
      // This does NOT skip required combat: findProgressObjective returns null
      // during the tutorial kill-phase (level < 2 || !questCompleted) and
      // during active boss fights (slimeRatBattleStarted && !defeated), so the
      // tree falls through to Engage/Collect/Hunt exactly when fighting is the
      // objective.
      this.buildProgressBehavior(),
      // Priority 3.5: Leave a safe room when enemies are present. The weapon is
      // hard-disabled while standing in a safe room (weaponSystem safe-space
      // gate), so neither side deals damage. Without this, an AI that meets an
      // NPC inside the starting safe room and then has the tutorial wave spawn
      // around the boundary deadlocks forever — holding melee range against
      // enemies it cannot damage while COLLECT keeps pulling it back inside.
      this.buildLeaveSafeRoomBehavior(),
      // Priority 4: Engage enemies
      this.buildEngageBehavior(),
      // Priority 5: Collect nearby loot
      this.buildCollectBehavior(),
      // Priority 6: Close distance to nearby enemies before wandering off
      this.buildHuntBehavior(),
      // Priority 7: Explore when nothing else to do
      this.buildExploreBehavior(),
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
            RETREAT_REPICK_ARRIVE_PX;
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
      if (Math.hypot(ex - playerX, ey - playerY) > RETREAT_THREAT_SCAN_PX) continue;
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

    const startTile = floorMap.pixelToTile(playerX, playerY);
    const candidates: Array<{ x: number; y: number; score: number }> = [];
    for (const offset of RETREAT_ARC_OFFSETS_RAD) {
      const angle = baseAngle + offset;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      for (const mult of RETREAT_DISTANCE_MULTS) {
        const dist = this.config.scanRadius * mult;
        const px = playerX + dirX * dist;
        const py = playerY + dirY * dist;
        const tile = floorMap.pixelToTile(px, py);
        if (tile.x === startTile.x && tile.y === startTile.y) continue;
        const passable = this.doorAwarePassable
          ? this.doorAwarePassable(tile.x, tile.y)
          : floorMap.tileMap.isPassable(tile.x, tile.y);
        if (!passable) continue;
        let minEnemyDist = Number.POSITIVE_INFINITY;
        for (const enemy of enemyPositions) {
          const d = Math.hypot(enemy.x - px, enemy.y - py);
          if (d < minEnemyDist) minEnemyDist = d;
        }
        candidates.push({ x: px, y: py, score: minEnemyDist });
      }
    }

    // Most open candidates first; A*-verify in score order and take the first
    // that is genuinely reachable. The verification budget keeps the scan cheap.
    candidates.sort((a, b) => b.score - a.score);
    let verifications = 0;
    for (const candidate of candidates) {
      if (verifications >= RETREAT_MAX_PATH_VERIFICATIONS) break;
      const goalTile = floorMap.pixelToTile(candidate.x, candidate.y);
      verifications += 1;
      const path = findTilePath(floorMap, startTile, goalTile, this.groundPathOptions());
      if (path.length > 1) {
        const center = floorMap.tileToPixel(goalTile.x, goalTile.y);
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
        // If this progress goal points at a living enemy (hunting quest mobs,
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
        this.decision.targetX = threat.x + (dx / len) * SAFE_ROOM_EXIT_OVERSHOOT_PX;
        this.decision.targetY = threat.y + (dy / len) * SAFE_ROOM_EXIT_OVERSHOOT_PX;
        this.decision.reason = `Leaving safe room to engage enemy at ${threat.distance.toFixed(0)}px`;
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

    // Inside a safe room the weapon is hard-disabled, so the player can neither
    // close the final px nor drop the enemy's HP. That is not "unreachable" —
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

  /**
   * Blacklist every loot pile (XP gem, gold, dropped item) within {@param radius}
   * px of the given point for {@link LOOT_IGNORE_FRAMES}. Used by the COLLECT dwell
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
   * Watchdog: break out of a COLLECT deadlock against an unreachable loot cluster.
   *
   * A per-target distance watchdog is defeated when the AI rotates between several
   * mutually-unreachable gems clustered at e.g. a safe-room boundary: each target
   * switch resets the per-target counter before it can fire, and per-frame stuck
   * detection is fooled by wiggle (net displacement stays a few px while the player
   * oscillates). So we track the player's NET displacement while it is continuously
   * in COLLECT. If the player never escapes a small dwell circle for
   * {@link COLLECT_DWELL_FRAMES}, the whole nearby cluster is unreachable — blacklist
   * every pile inside {@link COLLECT_DWELL_CLUSTER_RADIUS_PX} so the tree drops
   * through COLLECT to Hunt/Explore and makes real progress.
   */
  private updateCollectWatchdog(world: GameWorld, playerX: number, playerY: number): void {
    if (this.decision.state !== AIState.COLLECT) {
      this.collectDwellActive = false;
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
    if (drift > COLLECT_DWELL_ESCAPE_PX) {
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
        COLLECT_DWELL_CLUSTER_RADIUS_PX,
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
  private updateExploreWatchdog(playerX: number, playerY: number): void {
    if (this.decision.state !== AIState.EXPLORE) {
      this.exploreDwellActive = false;
      this.exploreDwellFrames = 0;
      return;
    }

    if (!this.exploreDwellActive) {
      this.exploreDwellActive = true;
      this.exploreDwellAnchorX = playerX;
      this.exploreDwellAnchorY = playerY;
      this.exploreDwellFrames = 0;
      return;
    }

    const drift = Math.hypot(
      playerX - this.exploreDwellAnchorX,
      playerY - this.exploreDwellAnchorY,
    );
    if (drift > EXPLORE_DWELL_ESCAPE_PX) {
      this.exploreDwellAnchorX = playerX;
      this.exploreDwellAnchorY = playerY;
      this.exploreDwellFrames = 0;
      return;
    }

    this.exploreDwellFrames++;
    if (this.exploreDwellFrames > EXPLORE_DWELL_FRAMES) {
      // Drop the unreachable frontier so the Explore node re-rolls a new target.
      this.decision.targetX = null;
      this.decision.targetY = null;
      this.pathWaypoints = [];
      this.pathIndex = 0;
      this.pathGoalKey = null;
      this.exploreDwellActive = false;
      this.exploreDwellFrames = 0;
      if (this.config.debug) {
        logger.debug(
          `AI abandoning unreachable explore frontier (dwell ${String(EXPLORE_DWELL_FRAMES)}f)`,
        );
      }
    }
  }

  /**
   * State-agnostic watchdog: break ANY parked-in-place deadlock, including the
   * cross-state thrash the per-state dwell watchdogs structurally cannot catch.
   *
   * The engage/collect/explore dwell watchdogs each reset the instant their
   * state stops running. When the tree flip-flops between two states every frame
   * (e.g. an enemy oscillating A*-reachable/unreachable as the player wiggles a
   * few px across a tile edge at a doorway choke, so it alternates ENGAGE one way
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

    const drift = Math.hypot(playerX - this.globalDwellAnchorX, playerY - this.globalDwellAnchorY);
    const closedOnEnemy =
      nearestDist < this.globalDwellBestEnemyDist - GLOBAL_DWELL_ENEMY_PROGRESS_PX;
    const dealtDamage = nearbyHp < this.globalDwellBestEnemyHp - ENGAGE_PROGRESS_EPSILON_PX;

    if (drift > GLOBAL_DWELL_ESCAPE_PX || closedOnEnemy || dealtDamage) {
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
      COLLECT_DWELL_CLUSTER_RADIUS_PX,
    );

    this.decision.targetEid = null;
    this.decision.targetX = null;
    this.decision.targetY = null;
    this.pathWaypoints = [];
    this.pathIndex = 0;
    this.pathGoalKey = null;
    this.engageTargetEid = null;
    this.engageNoProgressFrames = 0;

    this.globalDwellActive = false;
    this.globalDwellFrames = 0;
    if (this.config.debug) {
      logger.debug(
        `AI global dwell watchdog fired: relocating (loot ${String(blacklisted)} piles, dwell ${String(GLOBAL_DWELL_FRAMES)}f)`,
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
    this.updateExploreWatchdog(playerX, playerY);

    // State-agnostic backstop: break cross-state thrash (ENGAGE<->COLLECT every
    // frame at a navigation choke) that none of the per-state watchdogs above can
    // catch, since each resets the instant its state stops running.
    this.updateGlobalDwellWatchdog(world, playerX, playerY);

    // Refresh door-aware navigation each poll: closed-but-openable doors become
    // passable for A*, while locked-unsatisfied doors stay walls. Rebuilding
    // here picks up unlock conditions the player has just satisfied.
    this.refreshDoorNavigation(world);

    // Fold this frame's field-of-view into the cumulative fog-of-war "seen"
    // bitmap so frontier exploration (pickExploreTarget) can steer toward unseen
    // ground. Mirrors how the minimap accumulates per-frame FOV into a persistent
    // visited array, so the AI only ever "knows" what the player has actually seen.
    this.accumulateSeenTiles(world);

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

    // Close-range direct approach. Tile-granular A* targets tile centers and
    // cannot step the 24px player body onto a small (8px) pickup; worse,
    // resolveReachableGoalTile diverts to an ADJACENT tile whenever the target
    // sits in the player's own tile (same-tile A* is trivial), so the player
    // oscillates walk-away/walk-back around a gem/gold it never overlaps (the
    // "wiggling on pickups" bug). When the target is within ~1.5 tiles and a
    // straight corridor is clear, skip A* and slide straight at the exact pixel
    // with obstacle-aware local navigation so the body physically overlaps the
    // pickup and collision collects it.
    if (
      distance <= CLOSE_APPROACH_DIRECT_PX &&
      this.hasClearLineOfSight(world, playerX, playerY, targetX, targetY)
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
          // Wedge recovery: while aiming at this waypoint, watch real positional
          // progress. If collision pins the player in place (a doorway/corner
          // choke), skip the stuck waypoint and slide with local obstacle
          // avoidance so it threads the gap instead of vibrating short of it.
          const movedSinceLast = Number.isNaN(this.moveWedgeLastX)
            ? Number.POSITIVE_INFINITY
            : Math.hypot(playerX - this.moveWedgeLastX, playerY - this.moveWedgeLastY);
          this.moveWedgeLastX = playerX;
          this.moveWedgeLastY = playerY;
          if (movedSinceLast < MOVE_WEDGE_PROGRESS_PX) {
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
    for (let i = this.pathWaypoints.length - 1; i > this.pathIndex; i--) {
      const wp = this.pathWaypoints[i];
      if (!wp) {
        continue;
      }
      const wpWorld = floorMap.tileToPixel(wp.x, wp.y);
      if (this.hasClearLineOfSight(world, playerX, playerY, wpWorld.x, wpWorld.y)) {
        this.pathIndex = i;
        return;
      }
    }
  }

  /**
   * Sample the straight corridor between two world points and report whether
   * every sampled position is on passable ground. Used to decide when the AI may
   * abandon tile-granular A* for a direct sub-tile approach onto a close target
   * (see CLOSE_APPROACH_DIRECT_PX). Returns false when no floor map is present so
   * the caller keeps its existing A* / local-nav fallback.
   */
  private hasClearLineOfSight(
    world: GameWorld,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): boolean {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return false;
    }
    const distance = Math.hypot(endX - startX, endY - startY);
    if (distance <= 0) {
      return floorMap.isPassableAt(endX, endY);
    }
    const steps = Math.max(1, Math.ceil(distance / LINE_OF_SIGHT_SAMPLE_PX));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sampleX = startX + (endX - startX) * t;
      const sampleY = startY + (endY - startY) * t;
      if (!floorMap.isPassableAt(sampleX, sampleY)) {
        return false;
      }
    }
    return true;
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
      const dist = Math.hypot(x - playerX, y - playerY);
      if (dist <= maxRadius) {
        candidates.push({ eid, x, y, distance: dist });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);

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
   * Nearest dropped Gold pile within {@link maxRadius}px, ignoring loot we've
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
    let nearest: LootTarget | null = null;
    let minDist = maxRadius;

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
      if (dist < minDist) {
        minDist = dist;
        nearest = { eid, x, y, distance: dist, kind: 'gold' };
      }
    }

    return nearest;
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
        return this.createProgressTarget(
          questEnemy.x,
          questEnemy.y,
          playerX,
          playerY,
          `Hunting quest enemies (${ratsLeft} rats, ${slimesLeft} slimes to go)`,
          questEnemy.eid,
        );
      }
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

      // Still short on gold: actively farm the ambient swarm rather than wander.
      // The merchant errand cannot complete until the charm is bought, and the
      // charm needs gold that only drops from kills. Prefer sweeping up coins
      // that have already dropped (walking onto a pile collects it), otherwise
      // close on the nearest enemy so auto-fire generates more drops. Routing
      // this through Progress (which outranks Engage/Collect) is what makes the
      // AI commit to gold instead of treating distant enemies as "nothing to do"
      // and exploring away from them.
      const goldOwed = SHOPKEEPER_EQUIPMENT_COST - world.playerGold;
      const goldPile = this.findNearestGold(world, playerX, playerY, GOLD_FARM_GOLD_SCAN_RADIUS_PX);

      // Prefer a *nearby* pile we can realistically walk onto. The stuck handler
      // blacklists piles we get wedged against, so a deadlocked coin eventually
      // drops out of this scan and we fall through to hunting.
      if (goldPile && goldPile.distance <= GOLD_FARM_COLLECT_RADIUS_PX) {
        return this.createProgressTarget(
          goldPile.x,
          goldPile.y,
          playerX,
          playerY,
          `Collecting gold for the merchant charm (${goldOwed}g to go)`,
          goldPile.eid,
        );
      }

      // No close coin: close on the swarm so auto-fire drops fresh gold right at
      // the kill, which the branch above then sweeps up on a later tick.
      const prey = this.findNearestEnemy(world, playerX, playerY, GOLD_FARM_ENEMY_SCAN_RADIUS_PX);
      if (prey) {
        return this.createProgressTarget(
          prey.x,
          prey.y,
          playerX,
          playerY,
          `Hunting the swarm for charm gold (${goldOwed}g to go)`,
          prey.eid,
        );
      }

      // Nothing nearby to fight: a distant pile is still better than wandering.
      if (goldPile) {
        return this.createProgressTarget(
          goldPile.x,
          goldPile.y,
          playerX,
          playerY,
          `Collecting gold for the merchant charm (${goldOwed}g to go)`,
          goldPile.eid,
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
   * (eid &lt; 0), dead/despawned entities, and non-enemy entities such as gold
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
    const visible = floorMap.visible;
    if (!this.exploredSeen || this.exploredSeen.length !== visible.length) {
      this.exploredSeen = new Uint8Array(visible.length);
    }
    const seen = this.exploredSeen;
    for (let i = 0; i < visible.length; i += 1) {
      if (visible[i]) {
        seen[i] = 1;
      }
    }
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
   * Only frontiers beyond {@link EXPLORE_FRONTIER_MIN_PX} are returned so every
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

    const start = floorMap.pixelToTile(playerX, playerY);
    const startIdx = tileMap.index(start.x, start.y);
    if (startIdx === -1) {
      return null;
    }

    if (!this.frontierBfsVisited || this.frontierBfsVisited.length !== width * height) {
      this.frontierBfsVisited = new Uint8Array(width * height);
    }
    const visited = this.frontierBfsVisited;
    visited.fill(0);

    // Flat BFS queue of tile indices with a head pointer (avoids O(n) shift()).
    const queueX: number[] = [start.x];
    const queueY: number[] = [start.y];
    visited[startIdx] = 1;
    let head = 0;
    let expanded = 0;

    const neighborDx = [1, -1, 0, 0];
    const neighborDy = [0, 0, 1, -1];

    while (head < queueX.length && expanded < EXPLORE_FRONTIER_BFS_MAX_TILES) {
      const tx = queueX[head] as number;
      const ty = queueY[head] as number;
      head += 1;
      expanded += 1;

      let isFrontier = false;
      for (let d = 0; d < 4; d += 1) {
        const nx = tx + (neighborDx[d] as number);
        const ny = ty + (neighborDy[d] as number);
        const nIdx = tileMap.index(nx, ny);
        if (nIdx === -1) {
          continue;
        }
        if (seen[nIdx] === 0) {
          // An unseen in-bounds neighbour makes this tile a frontier.
          isFrontier = true;
          continue;
        }
        // Expand BFS only through seen + reachable ground so any frontier we
        // return is guaranteed reachable through known territory.
        if (visited[nIdx] === 0 && passable(nx, ny)) {
          visited[nIdx] = 1;
          queueX.push(nx);
          queueY.push(ny);
        }
      }

      if (isFrontier) {
        const px = floorMap.tileToPixel(tx, ty);
        const dist = Math.hypot(px.x - playerX, px.y - playerY);
        if (dist >= EXPLORE_FRONTIER_MIN_PX) {
          // BFS is nearest-first by step count, so the first frontier past the
          // minimum travel distance is effectively the nearest useful one.
          return { x: px.x, y: px.y };
        }
      }
    }

    return null;
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

    const startTile = floorMap.pixelToTile(playerX, playerY);

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
    const consider = (px: number, py: number): boolean => {
      if (!floorMap.isPassableAt(px, py)) {
        return false;
      }
      if (!sawPassable) {
        firstPassable.x = px;
        firstPassable.y = py;
        sawPassable = true;
      }
      const goalTile = floorMap.pixelToTile(px, py);
      const path = findTilePath(floorMap, startTile, goalTile, this.groundPathOptions());
      if (path.length > 1) {
        reachable.push({ x: px, y: py, dist: Math.hypot(px - playerX, py - playerY) });
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
        const candidate = floorMap.tileToPixel(tx, ty);
        if (consider(candidate.x, candidate.y)) {
          break;
        }
      }
    }

    if (reachable.length < EXPLORE_REACHABLE_SAMPLE_TARGET) {
      for (let attempt = 0; attempt < EXPLORE_REACHABLE_SAMPLE_ATTEMPTS; attempt += 1) {
        const tx = this.rng.nextInt(1, Math.max(1, floorMap.width - 2));
        const ty = this.rng.nextInt(1, Math.max(1, floorMap.height - 2));
        const candidate = floorMap.tileToPixel(tx, ty);
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
    if (!weapon || weapon.weaponType !== WeaponType.MELEE) {
      return {
        targetX: target.x,
        targetY: target.y,
        reason: `Engaging enemy at distance ${target.distance.toFixed(0)}px`,
      };
    }

    const reachPx = ftToPx(Math.max(weapon.range, weapon.aoeRadius));
    // Actual gate at which a melee swing connects (weaponSystem fires when an enemy
    // is within reach*1.5 and the cooldown has elapsed — independent of whether the
    // player is moving). Once inside it we KITE instead of parking.
    const strikeGatePx = reachPx * ATTACK_GATE_MULTIPLIER;
    if (target.distance <= strikeGatePx) {
      return this.computeMeleeKiteTarget(world, playerX, playerY, target, reachPx, strikeGatePx);
    }

    // Out of strike range: close in toward the orbit band (just inside the gate) so
    // the next poll can start kiting and landing hits.
    const engageBandPx = Math.max(DIRECT_MOVE_EPSILON_PX, reachPx - MELEE_APPROACH_BUFFER_PX);
    const deltaX = target.x - playerX;
    const deltaY = target.y - playerY;
    const scale = (target.distance - engageBandPx) / target.distance;
    return {
      targetX: playerX + deltaX * scale,
      targetY: playerY + deltaY * scale,
      reason: `Closing to melee range (${(reachPx / 8).toFixed(1)}ft) from ${target.distance.toFixed(0)}px`,
    };
  }

  /**
   * Melee kite: orbit the enemy inside the player's own strike gate while strafing
   * tangentially so the player stays mobile and dodges instead of standing still.
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
    reachPx: number,
    strikeGatePx: number,
  ): { targetX: number; targetY: number; reason: string } {
    const readiness = getActiveWeaponReadiness(world);
    const ready = readiness?.ready ?? true;

    const innerOrbit = Math.max(DIRECT_MOVE_EPSILON_PX, reachPx - MELEE_APPROACH_BUFFER_PX);
    const outerOrbit = Math.max(innerOrbit, strikeGatePx - MELEE_APPROACH_BUFFER_PX);
    let desiredOrbit = ready ? innerOrbit : outerOrbit;

    const enemyAttackPx = world.stores.enemyBehavior.attackRange[target.eid] ?? 0;
    if (enemyAttackPx > 0) {
      const safeOrbit = enemyAttackPx + KITE_DODGE_BUFFER_PX;
      if (safeOrbit <= outerOrbit) {
        // We can stand outside the enemy's strike range and still land hits.
        desiredOrbit = Math.min(outerOrbit, Math.max(desiredOrbit, safeOrbit));
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
    if (dist < 1) {
      // Enemy is on top of us — pick an arbitrary outward axis to escape along.
      rx = 1;
      ry = 0;
      dist = 1;
    }
    const ux = rx / dist;
    const uy = ry / dist;
    // Radial correction toward the desired orbit radius (+ux pushes outward).
    const radialMag = Math.max(
      -KITE_RADIAL_STEP_PX,
      Math.min(KITE_RADIAL_STEP_PX, desiredOrbit - dist),
    );

    const buildStep = (sign: 1 | -1): { x: number; y: number } => {
      const tx = -uy * sign;
      const ty = ux * sign;
      let sx = ux * radialMag + tx * KITE_STEP_PX;
      let sy = uy * radialMag + ty * KITE_STEP_PX;
      const slen = Math.hypot(sx, sy) || 1;
      sx = (sx / slen) * KITE_STEP_PX;
      sy = (sy / slen) * KITE_STEP_PX;
      return { x: sx, y: sy };
    };

    let step = buildStep(this.kiteOrbitSign);
    // Wall-aware juking: if the strafe direction is blocked, reverse so the player
    // dodges along open space instead of grinding the wall.
    if (!this.hasClearLineOfSight(world, playerX, playerY, playerX + step.x, playerY + step.y)) {
      const flipped: 1 | -1 = this.kiteOrbitSign === 1 ? -1 : 1;
      const flippedStep = buildStep(flipped);
      if (
        this.hasClearLineOfSight(
          world,
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
      reason: `Kiting enemy at ${target.distance.toFixed(0)}px (${ready ? 'strike' : 'dodge'}, orbit ${desiredOrbit.toFixed(0)}px)`,
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
    this.moveWedgeFrames = 0;
    this.moveWedgeLastX = Number.NaN;
    this.moveWedgeLastY = Number.NaN;
    this.stuckFrames = 0;
    this.ignoredLootUntilFrame.clear();
    this.ignoredEnemyUntilFrame.clear();
    this.enemyReachableCache.clear();
    this.engageTargetEid = null;
    this.engageNoProgressFrames = 0;
    this.engageBestDistance = Number.POSITIVE_INFINITY;
    this.engageBestHp = Number.POSITIVE_INFINITY;
    this.collectDwellActive = false;
    this.collectDwellAnchorX = 0;
    this.collectDwellAnchorY = 0;
    this.collectDwellFrames = 0;
    this.exploreDwellActive = false;
    this.exploreDwellAnchorX = 0;
    this.exploreDwellAnchorY = 0;
    this.exploreDwellFrames = 0;
    this.globalDwellActive = false;
    this.globalDwellAnchorX = 0;
    this.globalDwellAnchorY = 0;
    this.globalDwellFrames = 0;
    this.globalDwellBestEnemyDist = Number.POSITIVE_INFINITY;
    this.globalDwellBestEnemyHp = Number.POSITIVE_INFINITY;
    this.discoveredNpcDefs.clear();
    this.talkedNpcDefs.clear();
    this.neededInteractionReasonByNpc.clear();
    this.doorAwarePassable = null;
    this.knownLockedDoors.clear();
    this.exploredSeen = null;
    this.frontierBfsVisited = null;
    this.retreating = false;
    this.retreatTargetX = null;
    this.retreatTargetY = null;
    this.retreatRepickFrame = 0;
  }
}
