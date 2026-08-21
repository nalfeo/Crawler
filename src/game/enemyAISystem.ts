import { addComponent, hasComponent, query, setComponent } from 'bitecs';
import {
  DeathTimer,
  DoorState,
  Enemy,
  EnemyBehavior,
  EnemyProjectile,
  Player,
  Position,
  Velocity,
} from '../core/components.js';
import { findTilePath, PATH_TRAVERSAL, type TilePoint } from '../core/map/pathfinding.js';
import { computeFlowField, flowFieldStep, type FlowField } from '../core/map/flow-field.js';
import type { TileMap } from '../core/map/TileMap.js';
import { spawnAoeProjectile, spawnEnemyProjectile } from '../core/helpers.js';
import { isPointInSafeSpace } from '../core/safe-space.js';
import { getWorldFloorBehavior } from '../core/floor-behavior.js';
import type { GameWorld } from '../core/world.js';
import { computeEffectiveSpeed, getStatusEffects } from '../core/status-effects.js';
import {
  getMobAbilityMovementSpeedMultiplier,
  getMobAbilityRecoveryRemainingMs,
} from '../core/mob-abilities/runtime.js';
import {
  cancelEnemyProjectileTelegraph,
  getEffectiveTelegraphMs,
  isEnemyProjectileTelegraphReady,
  startEnemyProjectileTelegraph,
} from '../core/systems/enemyTelegraph.js';
import { ENEMY_PROJECTILE, TeamId } from '../shared/constants.js';
import { PATH_PERSONA, TRAVERSAL_MODE } from '../shared/enemy-behavior.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { SeededRandom } from '../shared/random.js';
import { normalize } from '../shared/vec.js';
import {
  DEFAULT_GENERATED_VISUAL_WIDTH_FT,
  getEntityNormalizedWeaponAnchor,
} from '../shared/generated-assets.js';
import { getFamilyAIDecision, resolveHostileFallback } from './systems/familyFeudSystem.js';
import { getCompanionAIDecision } from './systems/companionAISystem.js';
import { tagDamageMeta } from '../core/damage-meta.js';

export const AI_TYPE = {
  CHASE: 0,
  SWARM: 1,
  RANGED: 2,
  LEAPER: 3,
  GUARDIAN: 4,
  SUPPORT: 5,
} as const;
export { PATH_PERSONA, TRAVERSAL_MODE };

const DEFAULT_ENEMY_SPEED = 0.1875;
const EPSILON = 0.0001;
const SWARM_NEIGHBOR_RADIUS = 4;
const SWARM_PLAYER_WEIGHT = 1;
const SWARM_SEPARATION_WEIGHT = 1.4;
const SWARM_COHESION_WEIGHT = 0.2;
const MAX_OVERLAP_FRACTION = 0.25;
const SEPARATION_FORCE = 0.25;
const ENEMY_RADIUS = 1;
const MIN_MOB_PLAYER_DISTANCE = ENEMY_RADIUS * 2 * (1 - MAX_OVERLAP_FRACTION);
const STALE_PATH_FRAMES = 180;
const DEFAULT_PATH_REFRESH_FRAMES = 10;
const DEFAULT_FLANK_DISTANCE = 12;
const TARGET_SEARCH_RADIUS = 8;
const WAYPOINT_EPSILON = 0.5;
const NAVIGATION_LOOKAHEAD_FT = 3;
const WANDER_LOOKAHEAD_FT = 2.5;
const GUARDIAN_HOLD_DISTANCE = 3;
const SUPPORT_STANDOFF_DISTANCE = 12;
const SUPPORT_RETREAT_FRACTION = 0.65;
const DOOR_AVOID_RADIUS_TILES = 1;
const NAVIGATION_ANGLE_OFFSETS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2] as const;
const STUCK_FRAMES_THRESHOLD = 15;
const UNSTUCK_ANGLE_COUNT = 12;
const MAX_PAIRWISE_SEPARATION_ENEMIES = 48;
// The slime is a leaper: it runs a telegraph → committed leap → frozen recovery
// loop. Because the player should essentially never stop moving, a leap that
// commits toward the player's *current* position generally whiffs — the player
// sidesteps it. The dedicated counterplay is the frozen recovery: after landing,
// the slime sits still and exposed, and that is the window the player attacks
// into. The freeze (not the prep crouch) is now the reliable hittable window, so
// the slime can keep pouncing instead of reverting to an evasive juke.
//
// Distance at which a slime commits to a pounce. Beyond it the slime paths
// toward the player like a normal enemy; it only *enters* the telegraph → leap
// loop once it has closed to within ~5 ft. A slime's leap travels only a couple
// of feet at its low base speed, so winding up from across the room read as a
// leap at nothing — the pounce has to begin within leap distance to land as a
// real lunge at the player.
const SLIME_LEAP_RANGE = 5;
// Inner range below which a slime will not *start* a new pounce, closing like a
// normal enemy instead: point-blank it has nowhere to leap. Melee-range
// hittability — which the Floor 1 clear gate depends on — is guaranteed by the
// frozen-recovery window after every leap, not by this range: an in-flight
// pounce always finishes its full prep → leap → frozen-recovery cycle even when
// it lands inside the inner range, so the player always gets a stationary window
// to attack.
const SLIME_LEAP_INNER_RANGE = 2;
// Anticipation crouch before the pounce: a short, readable wind-up telegraph
// that tells the player a leap is coming. It no longer has to be the hittable
// window — the frozen recovery is — but it stays long enough to read clearly.
const SLIME_PREP_MIN_FRAMES = 14;
const SLIME_PREP_MAX_FRAMES = 24;
// A longer but still committed hop: enough travel to carry past the player's
// current position and force a dodge, while staying readable and leaving the
// punish window in the frozen recovery after landing.
const SLIME_LEAP_MIN_FRAMES = 10;
const SLIME_LEAP_MAX_FRAMES = 14;
// Frozen recovery after the slime lands. Velocity is zeroed for this window so
// the slime sits still and exposed — the deliberate opening for the player to
// land hits after dodging the leap. Sized generously (~0.33–0.57s at 60fps) so a
// moving player reliably gets a counter-attack in every cycle.
const SLIME_RECOVER_MIN_FRAMES = 20;
const SLIME_RECOVER_MAX_FRAMES = 34;
const SLIME_PREP_SPEED_MULT = 0.25;
// The leap reads as "jump quickly, maybe 1.5x speed". The bonus floor keeps the
// hop visibly fast for very slow slimes whose 1.5x is still sluggish. A slower
// leap also keeps the pounce hittable (it cannot blink through a strike).
const SLIME_LEAP_SPEED_MULT = 1.5;
const SLIME_LEAP_BONUS_SPEED = 0.075;
// Lateral arc applied across the leap so the pounce curves instead of tracking
// in a dead-straight line. Peaks at mid-leap (parabolic) and returns to zero.
// Kept small so the pounce stays readable and hittable rather than juking the
// player entirely.
const SLIME_LEAP_ARC = 0.15;
const SLIME_WIGGLE_BLEND = 0.7;
const SLIME_WIGGLE_FREQUENCY = 0.35;
const FIREBALL_DEF = getWeaponDef('fireball');

interface PathState {
  key: string;
  waypoints: TilePoint[];
  waypointIndex: number;
  lastComputedFrame: number;
  lastTouchedFrame: number;
}

interface DoorRevisionState {
  hash: number;
  revision: number;
}

interface WanderState {
  dirX: number;
  dirY: number;
  untilFrame: number;
}

interface SlimeLeapState {
  phase: 'prep' | 'leap' | 'recover';
  untilFrame: number;
  leapDirX: number;
  leapDirY: number;
  wiggleSign: number;
  leapTotalFrames: number;
}

const pathStatesByWorld = new WeakMap<GameWorld, Map<number, PathState>>();
const doorRevisionByWorld = new WeakMap<GameWorld, DoorRevisionState>();
const wanderStatesByWorld = new WeakMap<GameWorld, Map<number, WanderState>>();
const slimeLeapStatesByWorld = new WeakMap<GameWorld, Map<number, SlimeLeapState>>();

/**
 * Cross-enemy memo of computed tile paths, keyed on the same string as each
 * enemy's per-entity {@link PathState} (`enemyTile|targetTile|traversal|doorRev`).
 *
 * `findTilePath` is a pure function of the floor's static walls plus the live
 * door states; the only thing that mutates tile passability at runtime is a door
 * opening/closing, which `getDoorRevision` already folds into the key. So every
 * enemy that re-paths from the same tile toward the same target tile under the
 * same door revision computes a byte-identical path — historically once PER
 * ENEMY, PER refresh. This memo collapses those redundant A* searches (including
 * repeated *failed* searches to an unreachable target) into one, and it also
 * absorbs the extra churn when a moving target oscillates between a few tiles
 * and every chaser re-keys in lock-step. The cached arrays are treated as
 * read-only (`nextWaypointDirection` only reads `.length`/indexes and advances a
 * per-enemy cursor), so sharing one array across enemies is safe and allocation-
 * free. The map is cleared whenever the door revision changes, so it never
 * returns a path stale with respect to current passability and stays bounded to
 * the live door state's working set.
 */
const sharedPathMemoByWorld = new WeakMap<
  GameWorld,
  { revision: number; map: Map<string, TilePoint[]> }
>();

interface GroundFlowCache {
  goalX: number;
  goalY: number;
  doorRevision: number;
  field: FlowField;
}

// One shared ground flow field per world, aimed at the player's tile. Rebuilt
// only when the goal tile or the traversable layout (doors) changes, then reused
// by every ground chaser that frame.
const groundFlowByWorld = new WeakMap<GameWorld, GroundFlowCache>();

function getWanderStateMap(world: GameWorld): Map<number, WanderState> {
  let map = wanderStatesByWorld.get(world);
  if (!map) {
    map = new Map();
    wanderStatesByWorld.set(world, map);
  }
  return map;
}

function getSlimeLeapStateMap(world: GameWorld): Map<number, SlimeLeapState> {
  let map = slimeLeapStatesByWorld.get(world);
  if (!map) {
    map = new Map();
    slimeLeapStatesByWorld.set(world, map);
  }
  return map;
}

/**
 * Deterministic per-slime leap/prep duration in `[min, max]` frames.
 *
 * Intentionally does NOT draw from `world.rng`: the leap cadence is a cosmetic
 * movement flourish, and consuming the shared gameplay RNG here would shift the
 * entire deterministic stream that drives world generation, loot, spawns, and
 * the headless AI's own decisions. That coupling regressed the Floor 1
 * completion gate (a "known-good" seed reshuffled into a stuck run). Deriving
 * the duration from a stable hash of `eid` and `frameCount` keeps every slime's
 * timing varied and deterministic while leaving the gameplay RNG untouched.
 */
function deterministicLeapDuration(
  eid: number,
  frameCount: number,
  min: number,
  max: number,
): number {
  // FNV-1a-style integer mix over (eid, frameCount) for a well-distributed hash.
  let h = 2166136261;
  h = Math.imul(h ^ (eid | 0), 16777619);
  h = Math.imul(h ^ (frameCount | 0), 16777619);
  h ^= h >>> 15;
  const range = max - min + 1;
  return min + ((h >>> 0) % range);
}

function setVelocity(world: GameWorld, eid: number, x: number, y: number): void {
  if (Math.hypot(x, y) > EPSILON) {
    const enemyX = world.stores.position.x[eid] ?? 0;
    const enemyY = world.stores.position.y[eid] ?? 0;
    const nextX = enemyX + x;
    const nextY = enemyY + y;
    if (isPointInSafeSpace(world, nextX, nextY)) {
      setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
      return;
    }
  }
  setComponent(world.ecs, eid, Velocity, { x, y });
}

function getEnemySpeed(world: GameWorld, eid: number): number {
  const stored = world.stores.enemyBehavior.speed[eid]!;
  const base = stored > 0 ? stored : DEFAULT_ENEMY_SPEED;
  // Floor 2 Slice 3: fold the hate-band speed ramp (FR9) into the PRE-status
  // base first. The prepass in familyFeudSystem already clamped the boost to
  // `[baseSpeed, playerSpeed]` and only sets `effectiveSpeed` when it raises
  // above base, so this is a pure raise-up-toward-player of the base speed.
  const decision = getFamilyAIDecision(world, eid);
  const rampSpeed = decision?.effectiveSpeed;
  const rampedBase = rampSpeed !== undefined && rampSpeed > base ? rampSpeed : base;
  // Then compose active status effects on top — the single seam every enemy
  // speed read (wander, slime-leap prep/pounce, and the speed cap) derives
  // from. Because the slow multiplies the ramped base, status slows genuinely
  // take precedence: a slowed hate mob is slowed proportionally rather than
  // leaping over its own debuff, and slime-leap multipliers still layer on top.
  return (
    computeEffectiveSpeed(rampedBase, getStatusEffects(world, eid)) *
    getMobAbilityMovementSpeedMultiplier(world, eid)
  );
}

function getEnemySpeedCap(world: GameWorld, eid: number): number {
  const baseSpeed = getEnemySpeed(world, eid);
  if ((world.stores.enemyBehavior.type[eid] ?? AI_TYPE.CHASE) !== AI_TYPE.LEAPER) {
    return baseSpeed;
  }
  const leapState = getSlimeLeapStateMap(world).get(eid);
  if (leapState?.phase !== 'leap') {
    return baseSpeed;
  }
  return Math.max(baseSpeed + SLIME_LEAP_BONUS_SPEED, baseSpeed * SLIME_LEAP_SPEED_MULT);
}

function isNearDoor(
  world: GameWorld,
  x: number,
  y: number,
  radiusTiles = DOOR_AVOID_RADIUS_TILES,
): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return false;
  }
  const tile = floorMap.worldToTile(x, y);
  for (let dy = -radiusTiles; dy <= radiusTiles; dy += 1) {
    for (let dx = -radiusTiles; dx <= radiusTiles; dx += 1) {
      const tx = tile.x + dx;
      const ty = tile.y + dy;
      if (!floorMap.tileMap.inBounds(tx, ty)) {
        continue;
      }
      if (floorMap.tileMap.isDoor(tx, ty)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * When the player retreats into a safe room the doors reset to closed, breaking
 * line of sight. Mobs that were pressing the threshold must actively peel away
 * instead of camping the closed door. This returns a unit vector summing the
 * outward direction from every nearby door tile, biased away from the player so
 * the swarm disperses back into the level rather than orbiting the entrance.
 * Returns a zero vector when no doors are in range.
 */
function fleeFromDoorDirection(
  world: GameWorld,
  x: number,
  y: number,
  playerX: number,
  playerY: number,
  radiusTiles = DOOR_AVOID_RADIUS_TILES + 1,
): { x: number; y: number; length: number } {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return { x: 0, y: 0, length: 0 };
  }
  const tileSize = floorMap.config.tileSizeFt;
  const tile = floorMap.worldToTile(x, y);
  let sumX = 0;
  let sumY = 0;
  let doorCount = 0;
  for (let dy = -radiusTiles; dy <= radiusTiles; dy += 1) {
    for (let dx = -radiusTiles; dx <= radiusTiles; dx += 1) {
      const tx = tile.x + dx;
      const ty = tile.y + dy;
      if (!floorMap.tileMap.inBounds(tx, ty) || !floorMap.tileMap.isDoor(tx, ty)) {
        continue;
      }
      const doorX = tx * tileSize + tileSize / 2;
      const doorY = ty * tileSize + tileSize / 2;
      const away = normalize(x - doorX, y - doorY);
      if (away.length > EPSILON) {
        sumX += away.x;
        sumY += away.y;
        doorCount += 1;
      }
    }
  }
  if (doorCount === 0) {
    return { x: 0, y: 0, length: 0 };
  }
  const awayPlayer = normalize(x - playerX, y - playerY);
  sumX += awayPlayer.x;
  sumY += awayPlayer.y;
  return normalize(sumX, sumY);
}

function applyIdleWander(
  world: GameWorld,
  eid: number,
  speed: number,
  options?: { avoidDoors?: boolean; playerX?: number; playerY?: number },
): void {
  const wanderMap = getWanderStateMap(world);
  const px = world.stores.position.x[eid] ?? 0;
  const py = world.stores.position.y[eid] ?? 0;
  const avoidDoors = options?.avoidDoors ?? false;
  const playerX = options?.playerX;
  const playerY = options?.playerY;
  const isBlockedDirection = (dirX: number, dirY: number): boolean => {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return false;
    }
    const sampleX = px + dirX * WANDER_LOOKAHEAD_FT;
    const sampleY = py + dirY * WANDER_LOOKAHEAD_FT;
    return (
      !floorMap.isPassableAt(sampleX, sampleY) ||
      isPointInSafeSpace(world, sampleX, sampleY) ||
      (avoidDoors && isNearDoor(world, sampleX, sampleY))
    );
  };

  // De-aggro dispersal: a mob already sitting on a closed safe-room door must
  // peel away quickly so the swarm doesn't pile at the threshold. Drive it
  // directly outward from the door (toward passable, non-safe space) before the
  // usual random wander, which only avoids picking door-adjacent directions and
  // otherwise stalls a camped mob in place.
  if (avoidDoors && playerX !== undefined && playerY !== undefined) {
    const flee = fleeFromDoorDirection(world, px, py, playerX, playerY);
    if (flee.length > EPSILON) {
      const floorMap = world.floorMap;
      const aheadX = px + flee.x * WANDER_LOOKAHEAD_FT;
      const aheadY = py + flee.y * WANDER_LOOKAHEAD_FT;
      const clear =
        floorMap !== null &&
        floorMap.isPassableAt(aheadX, aheadY) &&
        !isPointInSafeSpace(world, aheadX, aheadY);
      if (clear) {
        wanderMap.delete(eid);
        setNavigatingVelocity(world, eid, flee.x, flee.y, Math.max(0.025, speed * 0.7));
        return;
      }
    }
  }

  let state = wanderMap.get(eid);
  const shouldPickNewDirection =
    !state || world.frameCount >= state.untilFrame || isBlockedDirection(state.dirX, state.dirY);

  if (shouldPickNewDirection) {
    const angle = world.rng.next() * Math.PI * 2;
    state = {
      dirX: Math.cos(angle),
      dirY: Math.sin(angle),
      untilFrame: world.frameCount + world.rng.nextInt(24, 96),
    };
    if (
      avoidDoors &&
      playerX !== undefined &&
      playerY !== undefined &&
      isBlockedDirection(state.dirX, state.dirY)
    ) {
      const awayFromPlayer = normalize(px - playerX, py - playerY);
      if (
        awayFromPlayer.length > EPSILON &&
        !isBlockedDirection(awayFromPlayer.x, awayFromPlayer.y)
      ) {
        state.dirX = awayFromPlayer.x;
        state.dirY = awayFromPlayer.y;
      }
    }
    wanderMap.set(eid, state);
  }

  if (!state) {
    setVelocity(world, eid, 0, 0);
    return;
  }
  if (isBlockedDirection(state.dirX, state.dirY)) {
    setVelocity(world, eid, 0, 0);
    return;
  }
  setNavigatingVelocity(world, eid, state.dirX, state.dirY, Math.max(0.025, speed * 0.45));
}

function createSlimePrepState(world: GameWorld, eid: number, previousSign = 1): SlimeLeapState {
  return {
    phase: 'prep',
    untilFrame:
      world.frameCount +
      deterministicLeapDuration(
        eid,
        world.frameCount,
        SLIME_PREP_MIN_FRAMES,
        SLIME_PREP_MAX_FRAMES,
      ),
    leapDirX: 0,
    leapDirY: 0,
    wiggleSign: previousSign,
    leapTotalFrames: 1,
  };
}

/**
 * Drive the slime's telegraph → committed leap → frozen recovery loop.
 *
 * Returns `true` when the slime is mid-cycle and this function owns its movement,
 * or `false` when there is no active pounce and the caller should fall back to a
 * normal chase.
 *
 * Only the *prep* wind-up is gated on the pounce band: if the player leaves the
 * band before the slime commits (closes inside the inner range, or escapes past
 * the outer range), the wind-up is abandoned and the slime chases normally. This
 * preserves the anti-deadlock guarantee that a slime is never *evasive* at melee
 * range — at close range it just closes in and stays hittable. Once the slime
 * commits, though, the leap (which travels toward the player) and the frozen
 * recovery (which is stationary) always run to completion regardless of distance,
 * since neither is evasive — guaranteeing the player a stationary window to
 * counter-attack after dodging the pounce.
 */
function applySlimeLeapBehavior(
  world: GameWorld,
  eid: number,
  playerDx: number,
  playerDy: number,
  distanceToPlayer: number,
  speed: number,
): boolean {
  const slimeMap = getSlimeLeapStateMap(world);
  let state = slimeMap.get(eid);
  const outsideBand =
    distanceToPlayer > SLIME_LEAP_RANGE || distanceToPlayer <= SLIME_LEAP_INNER_RANGE;
  if (!state) {
    // Only *begin* a pounce from within the pounce band. Too far → normal chase
    // closes the gap; already on top of the player → nothing to leap at, chase.
    if (outsideBand) {
      return false;
    }
    state = createSlimePrepState(world, eid, (eid & 1) === 0 ? -1 : 1);
    slimeMap.set(eid, state);
  }

  // Abandon an un-committed wind-up the moment the player leaves the band so the
  // slime never juke-wiggles at melee range (which deadlocked the Floor 1 clear).
  // A committed leap/recovery is allowed to finish below — it is not evasive.
  if (state.phase === 'prep' && outsideBand) {
    slimeMap.delete(eid);
    return false;
  }

  if (world.frameCount >= state.untilFrame) {
    if (state.phase === 'prep') {
      // Commit the leap toward where the player is *right now*. A moving player
      // will have slipped aside by the time the slime lands, so it generally
      // whiffs — that is by design.
      const toPlayer = normalize(playerDx, playerDy);
      const leapFrames = deterministicLeapDuration(
        eid,
        world.frameCount,
        SLIME_LEAP_MIN_FRAMES,
        SLIME_LEAP_MAX_FRAMES,
      );
      state.phase = 'leap';
      state.leapTotalFrames = leapFrames;
      state.untilFrame = world.frameCount + leapFrames;
      state.leapDirX = toPlayer.x;
      state.leapDirY = toPlayer.y;
      state.wiggleSign *= -1;
    } else if (state.phase === 'leap') {
      // Land and freeze: the slime is now exposed and stationary.
      state.phase = 'recover';
      state.untilFrame =
        world.frameCount +
        deterministicLeapDuration(
          eid,
          world.frameCount,
          SLIME_RECOVER_MIN_FRAMES,
          SLIME_RECOVER_MAX_FRAMES,
        );
    } else {
      // Recovery finished. Decide whether to wind up another pounce or hand the
      // slime back to a normal chase if the player has left the pounce band.
      if (outsideBand) {
        slimeMap.delete(eid);
        return false;
      }
      state.phase = 'prep';
      state.untilFrame =
        world.frameCount +
        deterministicLeapDuration(
          eid,
          world.frameCount,
          SLIME_PREP_MIN_FRAMES,
          SLIME_PREP_MAX_FRAMES,
        );
    }
  }

  if (state.phase === 'recover') {
    // Frozen recovery window: hold still so the player can land hits.
    setVelocity(world, eid, 0, 0);
    return true;
  }

  if (state.phase === 'prep') {
    const toPlayer = normalize(playerDx, playerDy);
    // Offset phase per enemy so nearby slimes do not wiggle in perfect sync.
    const wigglePulse = 0.5 + Math.sin((world.frameCount + eid) * SLIME_WIGGLE_FREQUENCY) * 0.5;
    const wiggleX = toPlayer.length > EPSILON ? -toPlayer.y * state.wiggleSign : state.wiggleSign;
    const wiggleY = toPlayer.length > EPSILON ? toPlayer.x * state.wiggleSign : 0;
    const desired = normalize(
      wiggleX * SLIME_WIGGLE_BLEND + toPlayer.x * (1 - SLIME_WIGGLE_BLEND),
      wiggleY * SLIME_WIGGLE_BLEND + toPlayer.y * (1 - SLIME_WIGGLE_BLEND),
    );
    const prepSpeed = Math.max(0.025, speed * SLIME_PREP_SPEED_MULT * (0.7 + wigglePulse * 0.3));
    setNavigatingVelocity(world, eid, desired.x, desired.y, prepSpeed);
    return true;
  }

  // Leap: travel along the committed direction with a parabolic lateral arc so
  // the pounce curves dramatically instead of homing in a straight line.
  const framesIntoLeap = state.leapTotalFrames - Math.max(0, state.untilFrame - world.frameCount);
  const leapProgress = Math.min(1, Math.max(0, framesIntoLeap / state.leapTotalFrames));
  const arc = Math.sin(leapProgress * Math.PI) * SLIME_LEAP_ARC * state.wiggleSign;
  const perpX = -state.leapDirY;
  const perpY = state.leapDirX;
  const leapDir = normalize(state.leapDirX + perpX * arc, state.leapDirY + perpY * arc);
  const leapSpeed = Math.max(speed + SLIME_LEAP_BONUS_SPEED, speed * SLIME_LEAP_SPEED_MULT);
  setNavigatingVelocity(world, eid, leapDir.x, leapDir.y, leapSpeed);
  return true;
}

function rotate(x: number, y: number, angle: number): { x: number; y: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  };
}

function setNavigatingVelocity(
  world: GameWorld,
  eid: number,
  desiredX: number,
  desiredY: number,
  speed: number,
): void {
  const desired = normalize(desiredX, desiredY);
  if (desired.length <= EPSILON) {
    setVelocity(world, eid, 0, 0);
    return;
  }

  const floorMap = world.floorMap;
  if (!floorMap) {
    setVelocity(world, eid, desired.x * speed, desired.y * speed);
    return;
  }

  const enemyX = world.stores.position.x[eid] ?? 0;
  const enemyY = world.stores.position.y[eid] ?? 0;

  for (const offset of NAVIGATION_ANGLE_OFFSETS) {
    const candidate = rotate(desired.x, desired.y, offset);
    const sampleX = enemyX + candidate.x * NAVIGATION_LOOKAHEAD_FT;
    const sampleY = enemyY + candidate.y * NAVIGATION_LOOKAHEAD_FT;
    if (floorMap.isPassableAt(sampleX, sampleY) && !isPointInSafeSpace(world, sampleX, sampleY)) {
      setVelocity(world, eid, candidate.x * speed, candidate.y * speed);
      return;
    }
  }

  setVelocity(world, eid, 0, 0);
}

/**
 * Unstuck mechanism: when an enemy is stuck (all basic angles blocked),
 * try a wider arc of angles or jiggle randomly.
 */
function tryUnstuckVelocity(
  world: GameWorld,
  eid: number,
  desiredX: number,
  desiredY: number,
  speed: number,
  random: SeededRandom,
): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  const enemyX = world.stores.position.x[eid] ?? 0;
  const enemyY = world.stores.position.y[eid] ?? 0;
  const desired = normalize(desiredX, desiredY);

  if (desired.length <= EPSILON) return;

  // Try wider arc: UNSTUCK_ANGLE_COUNT angles
  for (let i = 0; i < UNSTUCK_ANGLE_COUNT; i++) {
    const angle = (i / UNSTUCK_ANGLE_COUNT) * Math.PI * 2;
    const candidate = rotate(desired.x, desired.y, angle);
    const sampleX = enemyX + candidate.x * NAVIGATION_LOOKAHEAD_FT;
    const sampleY = enemyY + candidate.y * NAVIGATION_LOOKAHEAD_FT;
    if (floorMap.isPassableAt(sampleX, sampleY) && !isPointInSafeSpace(world, sampleX, sampleY)) {
      setVelocity(world, eid, candidate.x * speed, candidate.y * speed);
      return;
    }
  }

  // Still stuck — try random jiggle as last resort
  const jiggleAngle = random.next() * Math.PI * 2;
  const jiggle = {
    x: Math.cos(jiggleAngle),
    y: Math.sin(jiggleAngle),
  };
  setVelocity(world, eid, jiggle.x * speed, jiggle.y * speed);
}

function isAggroActive(aggroRange: number, distanceToPlayer: number): boolean {
  return aggroRange <= 0 || distanceToPlayer <= aggroRange;
}

function getPathStateMap(world: GameWorld): Map<number, PathState> {
  let map = pathStatesByWorld.get(world);
  if (!map) {
    map = new Map();
    pathStatesByWorld.set(world, map);
  }
  return map;
}

/**
 * Return the cross-enemy path memo for `world`, scoped to the current door
 * revision. When the revision changes (a door opened or closed), the cache is
 * cleared so it can never hand back a path computed against stale passability.
 */
function getSharedPathMemo(world: GameWorld, doorRevision: number): Map<string, TilePoint[]> {
  let entry = sharedPathMemoByWorld.get(world);
  if (!entry) {
    entry = { revision: doorRevision, map: new Map() };
    sharedPathMemoByWorld.set(world, entry);
  } else if (entry.revision !== doorRevision) {
    entry.revision = doorRevision;
    entry.map.clear();
  }
  return entry.map;
}

export function getDoorRevision(world: GameWorld, tileMap: TileMap): number {
  const doors = query(world.ecs, [DoorState]);
  const { doorState } = world.stores;
  let hash = 2_166_136_261;

  for (const eid of doors) {
    const tx = doorState.tileX[eid] ?? 0;
    const ty = doorState.tileY[eid] ?? 0;
    // Hash the LIVE physical tile passability, NOT the stored `effectiveOpen`
    // mirror or the `logicalOpen` latch: this revision gates flow-field /
    // tile-path memo invalidation, which are built over physical passability
    // (see buildDoorAwarePassable). `effectiveOpen` is only reconciled by
    // `doorSystem`, which runs AFTER `enemyAISystem` this frame; a floor
    // objective authority (`floor1ObjectiveTick`, invoked by
    // `floorObjectiveSystem` after `doorSystem`) can call `tileMap.openDoor(...)`
    // and set `logicalOpen` on boss/mini-boss defeat, so the stored
    // `effectiveOpen` mirror stays stale until the NEXT frame's `doorSystem`
    // pass — one AI tick too late. Reading the tile fresh each frame picks that
    // opening up immediately, matching the pre-migration `isOpen`-hash timing.
    const physicallyOpen = tileMap.isPassable(tx, ty) ? 1 : 0;
    hash ^= tx * 73856093;
    hash = Math.imul(hash, 16777619);
    hash ^= ty * 19349663;
    hash = Math.imul(hash, 16777619);
    hash ^= physicallyOpen;
    hash = Math.imul(hash, 16777619);
  }

  const existing = doorRevisionByWorld.get(world);
  if (!existing) {
    doorRevisionByWorld.set(world, { hash, revision: 1 });
    return 1;
  }

  if (existing.hash !== hash) {
    existing.hash = hash;
    existing.revision += 1;
  }
  return existing.revision;
}

function trimStalePaths(world: GameWorld, pathStates: Map<number, PathState>): void {
  for (const [eid, state] of pathStates.entries()) {
    if (world.frameCount - state.lastTouchedFrame > STALE_PATH_FRAMES) {
      pathStates.delete(eid);
    }
  }
}

function isTileTraversable(world: GameWorld, tile: TilePoint, traversalMode: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap || !floorMap.tileMap.inBounds(tile.x, tile.y)) {
    return false;
  }
  if (traversalMode === TRAVERSAL_MODE.FLYING) {
    return true;
  }
  return floorMap.tileMap.isPassable(tile.x, tile.y);
}

function findNearestTraversableTile(
  world: GameWorld,
  target: TilePoint,
  traversalMode: number,
): TilePoint | null {
  if (isTileTraversable(world, target, traversalMode)) {
    return target;
  }

  const floorMap = world.floorMap;
  if (!floorMap) {
    return null;
  }

  for (let radius = 1; radius <= TARGET_SEARCH_RADIUS; radius += 1) {
    for (let y = target.y - radius; y <= target.y + radius; y += 1) {
      for (let x = target.x - radius; x <= target.x + radius; x += 1) {
        if (Math.abs(x - target.x) !== radius && Math.abs(y - target.y) !== radius) {
          continue;
        }
        const candidate = { x, y };
        if (isTileTraversable(world, candidate, traversalMode)) {
          return candidate;
        }
      }
    }
  }

  return null;
}

function asTilePoint(world: GameWorld, px: number, py: number): TilePoint {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return { x: 0, y: 0 };
  }
  return floorMap.worldToTile(px, py);
}

// Exported for unit testing of the flank-target geometry (degenerate vs lateral).
export function makeFlankTargets(
  world: GameWorld,
  eid: number,
  enemyX: number,
  enemyY: number,
  playerX: number,
  playerY: number,
): TilePoint[] {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return [asTilePoint(world, playerX, playerY)];
  }

  const toPlayer = normalize(playerX - enemyX, playerY - enemyY);
  if (toPlayer.length <= EPSILON) {
    return [asTilePoint(world, playerX, playerY)];
  }

  const flankDistance = Math.max(
    floorMap.config.tileSizeFt * 2,
    world.stores.enemyBehavior.flankDistance[eid] || DEFAULT_FLANK_DISTANCE,
  );
  const sideDistance = Math.max(floorMap.config.tileSizeFt * 1.5, flankDistance * 0.5);
  const sideSign = eid % 2 === 0 ? 1 : -1;
  const leftX = -toPlayer.y;
  const leftY = toPlayer.x;

  return [
    asTilePoint(
      world,
      playerX + toPlayer.x * flankDistance + leftX * sideDistance * sideSign,
      playerY + toPlayer.y * flankDistance + leftY * sideDistance * sideSign,
    ),
    asTilePoint(
      world,
      playerX + toPlayer.x * flankDistance - leftX * sideDistance * sideSign,
      playerY + toPlayer.y * flankDistance - leftY * sideDistance * sideSign,
    ),
    asTilePoint(world, playerX + toPlayer.x * flankDistance, playerY + toPlayer.y * flankDistance),
    asTilePoint(world, playerX, playerY),
  ];
}

function choosePersonaTarget(
  world: GameWorld,
  eid: number,
  enemyX: number,
  enemyY: number,
  playerX: number,
  playerY: number,
  traversalMode: number,
): TilePoint | null {
  const persona = world.stores.enemyBehavior.persona[eid] ?? PATH_PERSONA.NAVIGATOR;
  const baseTarget = asTilePoint(world, playerX, playerY);

  if (persona !== PATH_PERSONA.FLANKER) {
    return findNearestTraversableTile(world, baseTarget, traversalMode);
  }

  const flankTargets = makeFlankTargets(world, eid, enemyX, enemyY, playerX, playerY);
  for (const target of flankTargets) {
    const traversable = findNearestTraversableTile(world, target, traversalMode);
    if (traversable) {
      return traversable;
    }
  }

  return null;
}

function nextWaypointDirection(
  world: GameWorld,
  eid: number,
  pathState: PathState,
  speed: number,
): { x: number; y: number; valid: boolean } {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return { x: 0, y: 0, valid: false };
  }

  const enemyX = world.stores.position.x[eid] ?? 0;
  const enemyY = world.stores.position.y[eid] ?? 0;
  const maxReach = Math.max(WAYPOINT_EPSILON, speed + 0.5);

  while (pathState.waypointIndex < pathState.waypoints.length) {
    const waypoint = pathState.waypoints[pathState.waypointIndex]!;
    const waypointCenter = floorMap.tileToWorld(waypoint.x, waypoint.y);
    const delta = normalize(waypointCenter.x - enemyX, waypointCenter.y - enemyY);

    if (delta.length <= maxReach) {
      pathState.waypointIndex += 1;
      continue;
    }

    return { x: delta.x, y: delta.y, valid: true };
  }

  return { x: 0, y: 0, valid: false };
}

/**
 * Get the shared ground flow field aimed at the player's current tile, rebuilding
 * it only when the goal tile or the traversable layout (doors) changes. One BFS
 * is shared by every ground chaser that frame, replacing a per-enemy A* storm.
 * Returns null when there is no floor map.
 */
function getGroundFlowField(
  world: GameWorld,
  playerX: number,
  playerY: number,
  doorRevision: number,
): GroundFlowCache | null {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return null;
  }

  const playerTile = floorMap.worldToTile(playerX, playerY);
  const goal = findNearestTraversableTile(world, playerTile, TRAVERSAL_MODE.GROUND) ?? playerTile;

  const cached = groundFlowByWorld.get(world);
  if (
    cached &&
    cached.goalX === goal.x &&
    cached.goalY === goal.y &&
    cached.doorRevision === doorRevision &&
    cached.field.width === floorMap.tileMap.width &&
    cached.field.height === floorMap.tileMap.height
  ) {
    return cached;
  }

  const field = computeFlowField(floorMap, goal, {
    traversalMode: PATH_TRAVERSAL.GROUND,
  });
  const next: GroundFlowCache = {
    goalX: goal.x,
    goalY: goal.y,
    doorRevision,
    field,
  };
  groundFlowByWorld.set(world, next);
  return next;
}

/**
 * Read-only accessor for the most recently built ground flow field, for
 * debugging/visualisation overlays (e.g. the AI runner lab). Returns null until
 * {@link enemyAISystem} has built one for this world.
 */
export function peekGroundFlowField(world: GameWorld): FlowField | null {
  return groundFlowByWorld.get(world)?.field ?? null;
}

/**
 * Steer `eid` one tile down the shared flow-field gradient toward the player.
 * O(1): a single neighbour lookup, no per-enemy search. Returns false when the
 * enemy sits on the goal tile or an unreachable tile so the caller can fall back
 * to A* or direct steering for the final approach.
 *
 * Diagonal steps steer along the gradient direction itself, while cardinal steps
 * seek the neighbouring tile centre. Aiming at a *diagonal* tile centre makes the
 * heading depend on sub-tile position and flip whenever an enemy drifts across
 * the shared corner into an orthogonal tile, which oscillates a dense swarm in
 * place; a pure direction is constant within a tile, so chasers glide along a
 * clean diagonal. Cardinal centre-seeking is retained because it gently
 * re-centres mobs on the tile lane and matches the validated baseline.
 */
function followFlowField(world: GameWorld, eid: number, speed: number, field: FlowField): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return false;
  }

  const enemyX = world.stores.position.x[eid] ?? 0;
  const enemyY = world.stores.position.y[eid] ?? 0;
  const tile = floorMap.worldToTile(enemyX, enemyY);
  const step = flowFieldStep(field, tile.x, tile.y);
  if (!step) {
    return false;
  }

  let direction: { x: number; y: number; length: number };
  if (step.x !== 0 && step.y !== 0) {
    direction = normalize(step.x, step.y);
  } else {
    const center = floorMap.tileToWorld(tile.x + step.x, tile.y + step.y);
    direction = normalize(center.x - enemyX, center.y - enemyY);
  }
  if (direction.length <= EPSILON) {
    setVelocity(world, eid, 0, 0);
    return true;
  }

  setVelocity(world, eid, direction.x * speed, direction.y * speed);
  return true;
}

function followPathWithCaching(
  world: GameWorld,
  eid: number,
  speed: number,
  targetTile: TilePoint,
  traversalMode: number,
  doorRevision: number,
): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return false;
  }

  const pathStates = getPathStateMap(world);
  const refreshFrames = Math.max(
    1,
    world.stores.enemyBehavior.pathRefreshFrames[eid] || DEFAULT_PATH_REFRESH_FRAMES,
  );
  const enemyTile = asTilePoint(
    world,
    world.stores.position.x[eid] ?? 0,
    world.stores.position.y[eid] ?? 0,
  );
  const pathKey = `${enemyTile.x},${enemyTile.y}|${targetTile.x},${targetTile.y}|${traversalMode}|${doorRevision}`;
  const previousState = pathStates.get(eid);

  let pathState = previousState;
  const shouldRefresh =
    !pathState ||
    pathState.key !== pathKey ||
    world.frameCount - pathState.lastComputedFrame >= refreshFrames ||
    pathState.waypointIndex >= pathState.waypoints.length;

  if (shouldRefresh) {
    // Reuse an identical path another enemy (or this one on an earlier frame)
    // already computed under the current door revision instead of running a
    // fresh A*. findTilePath is deterministic for a given key, so this is
    // behavior-preserving; it only removes redundant searches.
    const memo = getSharedPathMemo(world, doorRevision);
    let path = memo.get(pathKey);
    if (path === undefined) {
      path = findTilePath(floorMap, enemyTile, targetTile, {
        traversalMode:
          traversalMode === TRAVERSAL_MODE.FLYING ? PATH_TRAVERSAL.FLYING : PATH_TRAVERSAL.GROUND,
        maxPathLength: 8_192,
      });
      memo.set(pathKey, path);
    }
    if (path.length === 0) {
      pathStates.delete(eid);
      return false;
    }

    pathState = {
      key: pathKey,
      waypoints: path,
      waypointIndex: 1,
      lastComputedFrame: world.frameCount,
      lastTouchedFrame: world.frameCount,
    };
    pathStates.set(eid, pathState);
  } else if (pathState) {
    pathState.lastTouchedFrame = world.frameCount;
  }

  if (!pathState) {
    return false;
  }

  const direction = nextWaypointDirection(world, eid, pathState, speed);
  if (!direction.valid) {
    setVelocity(world, eid, 0, 0);
    return true;
  }

  setVelocity(world, eid, direction.x * speed, direction.y * speed);
  return true;
}

function isEnemyRoomDoorOpen(world: GameWorld, eid: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return true;
  }

  const enemyX = world.stores.position.x[eid] ?? 0;
  const enemyY = world.stores.position.y[eid] ?? 0;
  const tile = floorMap.worldToTile(enemyX, enemyY);
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  if (roomId < 0) {
    return true;
  }

  const room = floorMap.roomGraph.get(roomId);
  if (!room || room.doors.length === 0) {
    return true;
  }

  for (const door of room.doors) {
    if (floorMap.tileMap.isPassable(door.x, door.y)) {
      return true;
    }
  }

  return false;
}

function isPlayerInEnemyRoom(
  world: GameWorld,
  eid: number,
  playerX: number,
  playerY: number,
): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return false;
  }

  const enemyX = world.stores.position.x[eid] ?? 0;
  const enemyY = world.stores.position.y[eid] ?? 0;
  const enemyTile = floorMap.worldToTile(enemyX, enemyY);
  const enemyRoomId = floorMap.roomGraph.getRoomAt(enemyTile.x, enemyTile.y);
  if (enemyRoomId < 0) {
    return false;
  }

  const playerTile = floorMap.worldToTile(playerX, playerY);
  return floorMap.roomGraph.getRoomAt(playerTile.x, playerTile.y) === enemyRoomId;
}

function applyLegacyChase(
  world: GameWorld,
  eid: number,
  playerDx: number,
  playerDy: number,
  distanceToPlayer: number,
  aggroRange: number,
  speed: number,
): void {
  if (!isAggroActive(aggroRange, distanceToPlayer)) {
    setVelocity(world, eid, 0, 0);
    return;
  }

  setNavigatingVelocity(world, eid, playerDx, playerDy, speed);
}

function applyLegacySwarm(
  world: GameWorld,
  eid: number,
  swarmEntities: number[],
  playerDx: number,
  playerDy: number,
  distanceToPlayer: number,
  aggroRange: number,
  speed: number,
): void {
  if (!isAggroActive(aggroRange, distanceToPlayer)) {
    setVelocity(world, eid, 0, 0);
    return;
  }

  const { position } = world.stores;
  const enemyX = position.x[eid]!;
  const enemyY = position.y[eid]!;
  const toPlayer = normalize(playerDx, playerDy);
  let separationX = 0;
  let separationY = 0;
  let cohesionX = 0;
  let cohesionY = 0;
  let neighborCount = 0;

  for (const other of swarmEntities) {
    if (other === eid) {
      continue;
    }

    const otherX = position.x[other]!;
    const otherY = position.y[other]!;
    const offsetX = enemyX - otherX;
    const offsetY = enemyY - otherY;
    const distance = Math.hypot(offsetX, offsetY);

    if (distance <= EPSILON || distance > SWARM_NEIGHBOR_RADIUS) {
      continue;
    }

    const weight = (SWARM_NEIGHBOR_RADIUS - distance) / SWARM_NEIGHBOR_RADIUS;
    separationX += (offsetX / distance) * weight;
    separationY += (offsetY / distance) * weight;
    cohesionX += otherX;
    cohesionY += otherY;
    neighborCount += 1;
  }

  let steerX = toPlayer.x * SWARM_PLAYER_WEIGHT;
  let steerY = toPlayer.y * SWARM_PLAYER_WEIGHT;

  if (neighborCount > 0) {
    steerX += separationX * SWARM_SEPARATION_WEIGHT;
    steerY += separationY * SWARM_SEPARATION_WEIGHT;

    const localCenterX = cohesionX / neighborCount;
    const localCenterY = cohesionY / neighborCount;
    const cohesion = normalize(localCenterX - enemyX, localCenterY - enemyY);
    steerX += cohesion.x * SWARM_COHESION_WEIGHT;
    steerY += cohesion.y * SWARM_COHESION_WEIGHT;
  }

  setNavigatingVelocity(world, eid, steerX, steerY, speed);
}

/**
 * Spawns the actual hostile projectile from a given (origin, direction) pair.
 * Shared by the legacy zero-telegraph path (origin/direction = the enemy's
 * CURRENT position/aim, computed fresh this frame) and the telegraph-fire path
 * (origin/direction = the LOCKED values captured at telegraph start), so there
 * is exactly one place that turns "an aim solution" into "a projectile." Both
 * paths preserve immediate-fire timing, accuracy-roll timing, and cooldown
 * semantics while spawning at the exact ECS/visual pivot.
 */
function fireEnemyProjectileFrom(
  world: GameWorld,
  eid: number,
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
): void {
  const { enemyBehavior } = world.stores;
  // rng.next() returns [0,1); if the roll exceeds ACCURACY, the shot misses.
  // This roll intentionally stays at actual-fire-time (post-telegraph, if any)
  // so the 0ms-telegraph path preserves the exact legacy RNG-draw timing; the
  // accepted consequence is that a telegraph can occasionally show a locked
  // trajectory that never spawns a projectile (a "miss" still consumes cooldown).
  if (world.rng.next() > ENEMY_PROJECTILE.ACCURACY) {
    enemyBehavior.lastFireMs[eid] = world.elapsedMs;
    return;
  }

  if (FIREBALL_DEF) {
    const projectile = spawnAoeProjectile(
      world,
      originX,
      originY,
      dirX * FIREBALL_DEF.projectileSpeed,
      dirY * FIREBALL_DEF.projectileSpeed,
      FIREBALL_DEF.baseDamage,
      FIREBALL_DEF.aoeRadius,
      FIREBALL_DEF.baseDamage,
      eid,
      TeamId.ENEMY,
      FIREBALL_DEF.range,
    );
    addComponent(world.ecs, projectile, EnemyProjectile);
    // Tag enemy origin so the delayed AoE explosion snapshots the correct
    // source when it propagates metadata (see aoeOnImpactSystem).
    tagDamageMeta(world, projectile, {
      origin: 'enemy',
      affinity: 'unscaled',
      scaleWithPrimary: false,
      canCrit: false,
    });
  } else {
    spawnEnemyProjectile(
      world,
      originX,
      originY,
      dirX * ENEMY_PROJECTILE.SPEED,
      dirY * ENEMY_PROJECTILE.SPEED,
      ENEMY_PROJECTILE.DAMAGE,
      eid,
    );
  }

  enemyBehavior.lastFireMs[eid] = world.elapsedMs;
}

/**
 * Telegraph-aware fire state machine. Called every frame the enemy is in
 * attack range. Three paths:
 *  - Already telegraphing: ignore the (fresh, current-frame) `toPlayerX/Y`
 *    entirely — the aim is locked — and fire from the locked origin/direction
 *    once the resolved delay has elapsed.
 *  - Cooldown-ready, telegraph delay resolves to 0 (world/per-mob override):
 *    fire immediately using the current position/aim with unchanged timing
 *    and RNG-draw order.
 *  - Cooldown-ready, nonzero delay: lock the aim/origin now and start the
 *    telegraph; the actual shot fires on a later frame once ready.
 */
function tryFireEnemyProjectile(
  world: GameWorld,
  eid: number,
  toPlayerX: number,
  toPlayerY: number,
): void {
  const { enemyBehavior, position } = world.stores;

  if (enemyBehavior.telegraphActive[eid] === 1) {
    if (!isEnemyProjectileTelegraphReady(world, eid)) {
      return;
    }
    const dirX = enemyBehavior.telegraphDirX[eid]!;
    const dirY = enemyBehavior.telegraphDirY[eid]!;
    const originX = enemyBehavior.telegraphOriginX[eid]!;
    const originY = enemyBehavior.telegraphOriginY[eid]!;
    // Clear the active flag before firing so state is consistent even if the
    // accuracy roll below results in a miss (no projectile spawned).
    cancelEnemyProjectileTelegraph(world, eid);
    fireEnemyProjectileFrom(world, eid, originX, originY, dirX, dirY);
    return;
  }

  const cooldown = enemyBehavior.fireCooldownMs[eid]!;
  const effectiveCooldown = cooldown > 0 ? cooldown : ENEMY_PROJECTILE.FIRE_COOLDOWN_MS;
  const lastFire = enemyBehavior.lastFireMs[eid]!;

  if (lastFire > 0 && world.elapsedMs - lastFire < effectiveCooldown) {
    return;
  }

  const direction = normalize(toPlayerX, toPlayerY);
  if (direction.length <= EPSILON) {
    return;
  }

  const delayMs = getEffectiveTelegraphMs(world, eid);
  if (delayMs <= 0) {
    // Apply weapon anchor offset for immediate fires (no telegraph, so no
    // locked origin). Use normalized anchor to correctly handle art facing.
    const wa = getEntityNormalizedWeaponAnchor(world, eid);
    let originX = position.x[eid]!;
    let originY = position.y[eid]!;
    if (wa) {
      const facingRight = (world.stores.velocity.x[eid] ?? 0) >= 0;
      const needsMirror = wa.artFacing !== (facingRight ? 'right' : 'left');
      originX += (needsMirror ? -wa.relX : wa.relX) * DEFAULT_GENERATED_VISUAL_WIDTH_FT;
      originY += wa.relY * DEFAULT_GENERATED_VISUAL_WIDTH_FT;
    }
    fireEnemyProjectileFrom(world, eid, originX, originY, direction.x, direction.y);
    return;
  }

  startEnemyProjectileTelegraph(world, eid, direction.x, direction.y);
}

function applyLegacyRanged(
  world: GameWorld,
  eid: number,
  playerDx: number,
  playerDy: number,
  distanceToPlayer: number,
  aggroRange: number,
  attackRange: number,
  speed: number,
): void {
  if (!isAggroActive(aggroRange, distanceToPlayer)) {
    setVelocity(world, eid, 0, 0);
    return;
  }

  if (attackRange <= EPSILON) {
    setNavigatingVelocity(world, eid, playerDx, playerDy, speed);
    return;
  }

  const retreatDistance = attackRange * 0.5;
  const toPlayer = normalize(playerDx, playerDy);

  if (distanceToPlayer > attackRange) {
    setNavigatingVelocity(world, eid, toPlayer.x, toPlayer.y, speed);
    return;
  }

  if (distanceToPlayer < retreatDistance && distanceToPlayer > EPSILON) {
    setNavigatingVelocity(world, eid, -toPlayer.x, -toPlayer.y, speed);
    return;
  }

  const tangentX = -toPlayer.y;
  const tangentY = toPlayer.x;
  const tangent = normalize(tangentX, tangentY);
  setNavigatingVelocity(world, eid, tangent.x, tangent.y, speed);
}

function shouldGuardianHold(distanceToTarget: number): boolean {
  return distanceToTarget <= GUARDIAN_HOLD_DISTANCE;
}

function supportStandoffDistance(attackRange: number): number {
  return attackRange > EPSILON ? attackRange : SUPPORT_STANDOFF_DISTANCE;
}

function applyLegacyGuardian(
  world: GameWorld,
  eid: number,
  playerDx: number,
  playerDy: number,
  distanceToPlayer: number,
  aggroRange: number,
  speed: number,
): void {
  if (!isAggroActive(aggroRange, distanceToPlayer) || shouldGuardianHold(distanceToPlayer)) {
    setVelocity(world, eid, 0, 0);
    return;
  }

  setNavigatingVelocity(world, eid, playerDx, playerDy, speed);
}

function applyLegacySupport(
  world: GameWorld,
  eid: number,
  playerDx: number,
  playerDy: number,
  distanceToPlayer: number,
  aggroRange: number,
  attackRange: number,
  speed: number,
): void {
  if (!isAggroActive(aggroRange, distanceToPlayer)) {
    setVelocity(world, eid, 0, 0);
    return;
  }

  const standoffDistance = supportStandoffDistance(attackRange);
  const retreatDistance = standoffDistance * SUPPORT_RETREAT_FRACTION;
  const toPlayer = normalize(playerDx, playerDy);
  if (distanceToPlayer > standoffDistance) {
    setNavigatingVelocity(world, eid, toPlayer.x, toPlayer.y, speed);
    return;
  }
  if (distanceToPlayer < retreatDistance && distanceToPlayer > EPSILON) {
    setNavigatingVelocity(world, eid, -toPlayer.x, -toPlayer.y, speed);
    return;
  }
  setVelocity(world, eid, 0, 0);
}

function buildRangedPathTarget(
  eid: number,
  enemyX: number,
  enemyY: number,
  playerX: number,
  playerY: number,
  distanceToPlayer: number,
  attackRange: number,
): { x: number; y: number } {
  const toPlayer = normalize(playerX - enemyX, playerY - enemyY);
  if (attackRange <= EPSILON || toPlayer.length <= EPSILON) {
    return { x: playerX, y: playerY };
  }

  const retreatDistance = attackRange * 0.5;
  if (distanceToPlayer > attackRange) {
    return { x: playerX, y: playerY };
  }

  if (distanceToPlayer < retreatDistance) {
    return {
      x: enemyX - toPlayer.x * attackRange,
      y: enemyY - toPlayer.y * attackRange,
    };
  }

  const tangentSign = eid % 2 === 0 ? 1 : -1;
  return {
    x: enemyX + -toPlayer.y * tangentSign * attackRange * 0.65,
    y: enemyY + toPlayer.x * tangentSign * attackRange * 0.65,
  };
}

function buildSupportPathTarget(
  enemyX: number,
  enemyY: number,
  playerX: number,
  playerY: number,
  distanceToPlayer: number,
  attackRange: number,
): { x: number; y: number } | null {
  const toPlayer = normalize(playerX - enemyX, playerY - enemyY);
  if (toPlayer.length <= EPSILON) {
    return null;
  }

  const standoffDistance = supportStandoffDistance(attackRange);
  const retreatDistance = standoffDistance * SUPPORT_RETREAT_FRACTION;
  if (distanceToPlayer > standoffDistance) {
    return { x: playerX, y: playerY };
  }
  if (distanceToPlayer < retreatDistance) {
    return {
      x: enemyX - toPlayer.x * standoffDistance,
      y: enemyY - toPlayer.y * standoffDistance,
    };
  }
  return null;
}

/**
 * Fallback when pathing cannot produce a usable target/path.
 *
 * Returns `true` after applying direct chase steering for all non-ranged enemies,
 * or `false` for ranged enemies that should maintain spacing instead of hard-chasing.
 */
function tryFallbackChaseNavigation(
  world: GameWorld,
  eid: number,
  behaviorType: number,
  playerX: number,
  playerY: number,
  enemyX: number,
  enemyY: number,
  distanceToPlayer: number,
  speed: number,
  attackRange: number,
): boolean {
  // Ranged/support enemies maintain spacing; all other personas (including flankers
  // whose path target could not be found) fall back to direct chase so they never freeze.
  if (behaviorType === AI_TYPE.SUPPORT) {
    applyLegacySupport(
      world,
      eid,
      playerX - enemyX,
      playerY - enemyY,
      distanceToPlayer,
      Number.POSITIVE_INFINITY,
      attackRange,
      speed,
    );
    return true;
  }
  if (behaviorType === AI_TYPE.RANGED) {
    return false;
  }
  setNavigatingVelocity(world, eid, playerX - enemyX, playerY - enemyY, speed);
  return true;
}

function applyPathDrivenBehavior(
  world: GameWorld,
  eid: number,
  behaviorType: number,
  playerX: number,
  playerY: number,
  distanceToPlayer: number,
  speed: number,
  attackRange: number,
  doorRevision: number,
  groundFlow: GroundFlowCache | null,
): void {
  const enemyX = world.stores.position.x[eid] ?? 0;
  const enemyY = world.stores.position.y[eid] ?? 0;
  if (behaviorType === AI_TYPE.GUARDIAN && shouldGuardianHold(distanceToPlayer)) {
    setVelocity(world, eid, 0, 0);
    return;
  }
  const traversalMode = world.stores.enemyBehavior.traversalMode[eid] ?? TRAVERSAL_MODE.GROUND;
  const personaTarget = choosePersonaTarget(
    world,
    eid,
    enemyX,
    enemyY,
    playerX,
    playerY,
    traversalMode,
  );
  if (!personaTarget) {
    if (
      tryFallbackChaseNavigation(
        world,
        eid,
        behaviorType,
        playerX,
        playerY,
        enemyX,
        enemyY,
        distanceToPlayer,
        speed,
        attackRange,
      )
    ) {
      return;
    }
    setVelocity(world, eid, 0, 0);
    return;
  }

  let targetTile = personaTarget;
  if (behaviorType === AI_TYPE.RANGED) {
    const rangedTargetFt = buildRangedPathTarget(
      eid,
      enemyX,
      enemyY,
      playerX,
      playerY,
      distanceToPlayer,
      attackRange,
    );
    const preferred = asTilePoint(world, rangedTargetFt.x, rangedTargetFt.y);
    const fallback = findNearestTraversableTile(world, preferred, traversalMode);
    if (fallback) {
      targetTile = fallback;
    }
  } else if (behaviorType === AI_TYPE.SUPPORT) {
    const supportTargetFt = buildSupportPathTarget(
      enemyX,
      enemyY,
      playerX,
      playerY,
      distanceToPlayer,
      attackRange,
    );
    if (supportTargetFt === null) {
      setVelocity(world, eid, 0, 0);
      return;
    }
    const preferred = asTilePoint(world, supportTargetFt.x, supportTargetFt.y);
    const fallback = findNearestTraversableTile(world, preferred, traversalMode);
    if (fallback) {
      targetTile = fallback;
    } else {
      applyLegacySupport(
        world,
        eid,
        playerX - enemyX,
        playerY - enemyY,
        distanceToPlayer,
        Number.POSITIVE_INFINITY,
        attackRange,
        speed,
      );
      return;
    }
  }

  // Shared flow-field fast path: every ground chaser heads for the player's tile,
  // so one BFS (built once per frame) replaces their individual A* searches. Only
  // eligible when the resolved target IS the field's goal — ranged standoff and
  // flank targets differ, so those keep using per-enemy A*.
  let usedPath = false;
  if (
    groundFlow &&
    traversalMode === TRAVERSAL_MODE.GROUND &&
    targetTile.x === groundFlow.goalX &&
    targetTile.y === groundFlow.goalY
  ) {
    usedPath = followFlowField(world, eid, speed, groundFlow.field);
  }
  if (!usedPath) {
    usedPath = followPathWithCaching(world, eid, speed, targetTile, traversalMode, doorRevision);
  }

  if (!usedPath) {
    const waypoint = world.floorMap?.tileToWorld(targetTile.x, targetTile.y);
    if (!waypoint) {
      if (
        tryFallbackChaseNavigation(
          world,
          eid,
          behaviorType,
          playerX,
          playerY,
          enemyX,
          enemyY,
          distanceToPlayer,
          speed,
          attackRange,
        )
      ) {
        return;
      }
      setVelocity(world, eid, 0, 0);
      return;
    }
    const fallback = normalize(waypoint.x - enemyX, waypoint.y - enemyY);
    if (fallback.length > EPSILON) {
      setVelocity(world, eid, fallback.x * speed, fallback.y * speed);
      return;
    }
    // Tile center already reached but the player may have drifted within the
    // tile. Close the remaining sub-tile gap directly so the enemy does not
    // stall at the tile centre while the player is still a short distance away.
    if (
      distanceToPlayer > MIN_MOB_PLAYER_DISTANCE &&
      (behaviorType === AI_TYPE.CHASE ||
        behaviorType === AI_TYPE.SWARM ||
        behaviorType === AI_TYPE.LEAPER ||
        behaviorType === AI_TYPE.GUARDIAN)
    ) {
      const toPlayer = normalize(playerX - enemyX, playerY - enemyY);
      setNavigatingVelocity(world, eid, toPlayer.x, toPlayer.y, speed);
      return;
    }
    setVelocity(world, eid, 0, 0);
    return;
  }

  // Keep chase/swarm mobs converging on the player instead of mirroring lateral
  // player strafes tile-for-tile when pathing updates are frequent.
  const persona = world.stores.enemyBehavior.persona[eid] ?? PATH_PERSONA.NAVIGATOR;
  if (
    (behaviorType === AI_TYPE.CHASE || behaviorType === AI_TYPE.SWARM) &&
    persona === PATH_PERSONA.NAVIGATOR &&
    traversalMode !== TRAVERSAL_MODE.FLYING
  ) {
    const currentVx = world.stores.velocity.x[eid] ?? 0;
    const currentVy = world.stores.velocity.y[eid] ?? 0;
    const pathDirection = normalize(currentVx, currentVy);
    const toPlayer = normalize(playerX - enemyX, playerY - enemyY);
    if (pathDirection.length > EPSILON && toPlayer.length > EPSILON) {
      const blended = normalize(
        pathDirection.x * 0.7 + toPlayer.x * 0.3,
        pathDirection.y * 0.7 + toPlayer.y * 0.3,
      );
      if (blended.length > EPSILON) {
        setNavigatingVelocity(world, eid, blended.x, blended.y, speed);
      }
    } else if (pathDirection.length <= EPSILON && distanceToPlayer > MIN_MOB_PLAYER_DISTANCE) {
      // Path waypoints exhausted (enemy on or very near the player's tile) but
      // the player has drifted within the tile. Drive toward the player's exact
      // world position so the enemy commits to contact range instead of stopping.
      setNavigatingVelocity(world, eid, toPlayer.x, toPlayer.y, speed);
    }
  } else if (
    behaviorType !== AI_TYPE.RANGED &&
    behaviorType !== AI_TYPE.SUPPORT &&
    distanceToPlayer > MIN_MOB_PLAYER_DISTANCE
  ) {
    // Non-NAVIGATOR, non-RANGED/non-SUPPORT enemies (e.g. FLANKER persona) should never stall
    // mid-pursuit when their path exhausts but the player is still out of contact
    // range. Drive directly toward the player as a gap-closing fallback.
    const currentVx = world.stores.velocity.x[eid] ?? 0;
    const currentVy = world.stores.velocity.y[eid] ?? 0;
    if (Math.hypot(currentVx, currentVy) <= EPSILON) {
      const toPlayer = normalize(playerX - enemyX, playerY - enemyY);
      if (toPlayer.length > EPSILON) {
        setNavigatingVelocity(world, eid, toPlayer.x, toPlayer.y, speed);
      }
    }
  }
}

function applySeparation(
  world: GameWorld,
  activeEnemies: number[],
  position: GameWorld['stores']['position'],
  velocity: GameWorld['stores']['velocity'],
  playerX: number,
  playerY: number,
): void {
  const minDistance = ENEMY_RADIUS * 2 * (1 - MAX_OVERLAP_FRACTION);
  const separationEnemies =
    activeEnemies.length <= MAX_PAIRWISE_SEPARATION_ENEMIES
      ? activeEnemies
      : [...activeEnemies]
          .sort((a, b) => {
            const adx = (position.x[a] ?? 0) - playerX;
            const ady = (position.y[a] ?? 0) - playerY;
            const bdx = (position.x[b] ?? 0) - playerX;
            const bdy = (position.y[b] ?? 0) - playerY;
            return adx * adx + ady * ady - (bdx * bdx + bdy * bdy);
          })
          .slice(0, MAX_PAIRWISE_SEPARATION_ENEMIES);

  for (let i = 0; i < separationEnemies.length; i += 1) {
    const a = separationEnemies[i]!;
    const ax = position.x[a]!;
    const ay = position.y[a]!;

    for (let j = i + 1; j < separationEnemies.length; j += 1) {
      const b = separationEnemies[j]!;
      const bx = position.x[b]!;
      const by = position.y[b]!;

      const dx = ax - bx;
      const dy = ay - by;
      const dist = Math.hypot(dx, dy);

      if (dist >= minDistance) {
        continue;
      }

      let nx: number;
      let ny: number;
      let penetration: number;

      if (dist <= EPSILON) {
        nx = a % 2 === 0 ? 1 : -1;
        ny = b % 2 === 0 ? 1 : -1;
        const len = Math.hypot(nx, ny);
        nx /= len;
        ny /= len;
        penetration = 1;
      } else {
        penetration = (minDistance - dist) / minDistance;
        nx = dx / dist;
        ny = dy / dist;
      }

      const force = penetration * SEPARATION_FORCE;
      // A telegraphing enemy's aim/origin are locked to its position at
      // telegraph-start (core/systems/enemyTelegraph.ts) and must stay put for
      // the whole window — it still repels others as an obstacle, but must
      // not itself receive a separation impulse.
      if ((world.stores.enemyBehavior.telegraphActive[a] ?? 0) !== 1) {
        velocity.x[a] = (velocity.x[a] ?? 0) + nx * force;
        velocity.y[a] = (velocity.y[a] ?? 0) + ny * force;
      }
      if ((world.stores.enemyBehavior.telegraphActive[b] ?? 0) !== 1) {
        velocity.x[b] = (velocity.x[b] ?? 0) - nx * force;
        velocity.y[b] = (velocity.y[b] ?? 0) - ny * force;
      }
    }
  }

  if (world.floorMap) {
    // Clamp enemy motion so mobs cannot exceed the shared player overlap cap.
    // This keeps one collision restriction path for all personas/traversal modes.
    for (const eid of activeEnemies) {
      const enemyX = position.x[eid] ?? 0;
      const enemyY = position.y[eid] ?? 0;
      const currentVx = velocity.x[eid] ?? 0;
      const currentVy = velocity.y[eid] ?? 0;
      const speed = Math.hypot(currentVx, currentVy);

      if (speed <= EPSILON) {
        continue;
      }

      const toPlayerX = playerX - enemyX;
      const toPlayerY = playerY - enemyY;
      const distance = Math.hypot(toPlayerX, toPlayerY);
      let toward = normalize(toPlayerX, toPlayerY);

      if (toward.length <= EPSILON) {
        const velocityDirection = normalize(currentVx, currentVy);
        toward =
          velocityDirection.length > EPSILON
            ? velocityDirection
            : { x: eid % 2 === 0 ? 1 : -1, y: 0, length: 1 };
      }

      const radialToward = currentVx * toward.x + currentVy * toward.y;
      if (radialToward <= EPSILON) {
        continue;
      }

      const allowedTowardStep = Math.max(0, distance - MIN_MOB_PLAYER_DISTANCE);
      if (radialToward <= allowedTowardStep + EPSILON) {
        continue;
      }

      const tangentX = currentVx - toward.x * radialToward;
      const tangentY = currentVy - toward.y * radialToward;
      const clampedToward = Math.min(radialToward, allowedTowardStep);
      const tangentMagnitude = Math.hypot(tangentX, tangentY);

      if (clampedToward <= EPSILON && tangentMagnitude <= EPSILON) {
        const tangentSign = eid % 2 === 0 ? 1 : -1;
        velocity.x[eid] = -toward.y * tangentSign * speed;
        velocity.y[eid] = toward.x * tangentSign * speed;
        continue;
      }

      velocity.x[eid] = tangentX + toward.x * clampedToward;
      velocity.y[eid] = tangentY + toward.y * clampedToward;
    }
  }

  for (const eid of activeEnemies) {
    const vx = velocity.x[eid] ?? 0;
    const vy = velocity.y[eid] ?? 0;
    const mag = Math.hypot(vx, vy);
    const maxSpeed = getEnemySpeedCap(world, eid);

    if (mag > maxSpeed && mag > EPSILON) {
      const scale = maxSpeed / mag;
      setVelocity(world, eid, vx * scale, vy * scale);
    } else {
      setVelocity(world, eid, vx, vy);
    }
  }
}

export function enemyAISystem(world: GameWorld): void {
  const enemies = query(world.ecs, [Enemy, EnemyBehavior, Position, Velocity]);
  const players = query(world.ecs, [Player, Position]);
  const playerEid = players[0];
  const pathStates = getPathStateMap(world);
  const lineOfSightAggro = getWorldFloorBehavior(world).lineOfSightAggro;

  if (world.frameCount % 60 === 0) {
    trimStalePaths(world, pathStates);
  }

  if (playerEid === undefined) {
    const slimeMap = getSlimeLeapStateMap(world);
    for (const eid of enemies) {
      setVelocity(world, eid, 0, 0);
      pathStates.delete(eid);
      slimeMap.delete(eid);
      // No player to aim at or fire on — cancel any in-progress telegraph so
      // its locked origin/direction can never survive into a state where the
      // reason it was aimed no longer exists (see enemyTelegraph.ts's
      // "cancel from every pre-fire early exit" contract).
      cancelEnemyProjectileTelegraph(world, eid);
    }
    return;
  }

  const floorMap = world.floorMap;
  const { enemyBehavior, position, velocity } = world.stores;
  const enemyList = Array.from(enemies);
  if (world.frameCount % 60 === 0) {
    const activeEnemySet = new Set(enemyList);
    const wanderMap = getWanderStateMap(world);
    const slimeMap = getSlimeLeapStateMap(world);
    for (const eid of [...wanderMap.keys()]) {
      if (!activeEnemySet.has(eid)) {
        wanderMap.delete(eid);
      }
    }
    for (const eid of [...slimeMap.keys()]) {
      if (!activeEnemySet.has(eid)) {
        slimeMap.delete(eid);
      }
    }
  }
  const playerX = position.x[playerEid]!;
  const playerY = position.y[playerEid]!;
  const swarmEntities = enemyList.filter((eid) => enemyBehavior.type[eid] === AI_TYPE.SWARM);
  const activeEnemies: number[] = [];
  const doorRevision = floorMap ? getDoorRevision(world, floorMap.tileMap) : 0;
  const groundFlow = getGroundFlowField(world, playerX, playerY, doorRevision);
  const playerHiddenInSafeRoom = world.playerInSafeRoom;
  const inactiveFloor2Bosses = new Set(
    [...(world.floorExtendedState?.familyState?.bossEncounters?.values() ?? [])]
      .filter((encounter) => !encounter.started && encounter.bossEid !== null)
      .map((encounter) => encounter.bossEid as number),
  );

  for (const eid of enemies) {
    if (inactiveFloor2Bosses.has(eid)) {
      setVelocity(world, eid, 0, 0);
      pathStates.delete(eid);
      cancelEnemyProjectileTelegraph(world, eid);
      continue;
    }
    // Corpses in their death-linger window keep Enemy/Velocity components until
    // deathTimerSystem removes them. They must not chase, fire, or steer — zero
    // their velocity and skip AI. The death knockback slide is applied
    // independently by knockbackSystem.
    if (hasComponent(world.ecs, eid, DeathTimer)) {
      setVelocity(world, eid, 0, 0);
      pathStates.delete(eid);
      getSlimeLeapStateMap(world).delete(eid);
      cancelEnemyProjectileTelegraph(world, eid);
      continue;
    }

    const enemyX = position.x[eid]!;
    const enemyY = position.y[eid]!;
    // Floor 2 Slice 3: family AI target override. If familyFeudSystem picked a
    // virtual target for this mob (band-driven follow/idle/attacker/rival), use
    // it as the "player" the rest of this loop chases. Trash mobs (no
    // FamilyMembership) and hate/hostile mobs whose player IS reachable receive
    // no override here — familyFeudSystem left decision.bypassPlayerDetection
    // false in that case. The hate/hostile rival-fallback is resolved lower
    // down, once canDetectPlayer has been computed.
    const companionDecision = getCompanionAIDecision(world, eid);
    if (companionDecision?.kind === 'disabled') {
      setVelocity(world, eid, 0, 0);
      enemyBehavior.stuckFrames[eid] = 0;
      pathStates.delete(eid);
      getSlimeLeapStateMap(world).delete(eid);
      cancelEnemyProjectileTelegraph(world, eid);
      continue;
    }
    const familyDecision = getFamilyAIDecision(world, eid);
    const targetOverride =
      companionDecision?.bypassPlayerDetection === true ? companionDecision : familyDecision;
    let virtualPlayerX = playerX;
    let virtualPlayerY = playerY;
    if (targetOverride !== undefined && targetOverride.bypassPlayerDetection) {
      virtualPlayerX = targetOverride.x;
      virtualPlayerY = targetOverride.y;
    }
    let playerDx = virtualPlayerX - enemyX;
    let playerDy = virtualPlayerY - enemyY;
    let distanceToPlayer = Math.hypot(playerDx, playerDy);
    const behaviorType = enemyBehavior.type[eid]!;
    const aggroRange = enemyBehavior.aggroRange[eid]!;
    const aggroEnableAtMs = enemyBehavior.aggroEnableAtMs[eid] ?? 0;
    const attackRange = enemyBehavior.attackRange[eid]!;
    const speed = getEnemySpeed(world, eid);
    const persona = enemyBehavior.persona[eid] ?? PATH_PERSONA.NAVIGATOR;
    const hasOpenRoomDoor = isEnemyRoomDoorOpen(world, eid);
    const playerSharesRoom = isPlayerInEnemyRoom(world, eid, playerX, playerY);
    const permanentAggro = (enemyBehavior.aggroedPermanently?.[eid] ?? 0) === 1;
    // For a mob with a prepass-driven virtual target (Companion or Family Feud)
    // we measure aggro against the virtual target (distanceToPlayer already
    // reflects that), and set `familyBypass` so player-side FOV/room checks
    // don't cancel engagement.
    const familyBypass = targetOverride !== undefined && targetOverride.bypassPlayerDetection;
    const inAggroRange =
      familyBypass || permanentAggro || isAggroActive(aggroRange, distanceToPlayer);
    // Cave interiors can share open geometry without sharing a semantic room ID.
    // Evaluate the costly Bresenham LOS only after cheap gates fail and the
    // enemy is in range — avoid O(ray-length) work for already-qualified mobs.
    // Opt-in per floor (`behavior.lineOfSightAggro`): floors without it keep
    // the legacy room/door-driven aggro behavior.
    const hasDirectPlayerSight =
      !familyBypass &&
      lineOfSightAggro &&
      !playerHiddenInSafeRoom &&
      inAggroRange &&
      !hasOpenRoomDoor &&
      !playerSharesRoom &&
      !permanentAggro &&
      floorMap !== null &&
      floorMap.hasLineOfSight(enemyX, enemyY, playerX, playerY);
    let canDetectPlayer =
      familyBypass ||
      (!playerHiddenInSafeRoom &&
        (hasOpenRoomDoor || playerSharesRoom || hasDirectPlayerSight || permanentAggro) &&
        inAggroRange);

    if (world.elapsedMs < aggroEnableAtMs) {
      setVelocity(world, eid, 0, 0);
      enemyBehavior.stuckFrames[eid] = 0;
      pathStates.delete(eid);
      getSlimeLeapStateMap(world).delete(eid);
      cancelEnemyProjectileTelegraph(world, eid);
      continue;
    }

    // Hate/hostile mobs fall back to a rival target when the player is genuinely
    // unreachable this frame. The prepass couldn't do this itself because it
    // doesn't know canDetectPlayer. `!familyBypass` already excludes any mob
    // that ALREADY holds a bypass target (rival-primary / follow / attacker /
    // idle); the only non-bypass decision the prepass stamps is the hate
    // speed-ramp (kind:'player', bypassPlayerDetection:false). So we must NOT
    // additionally gate on `familyDecision === undefined` — doing so let a hate
    // mob whose ramp fired skip the fallback while an identical un-ramped hate
    // mob reached it. resolveHostileFallback returns null for non-family and
    // non-hate/hostile mobs, so trash/neutral/friendly mobs are unaffected.
    if (!familyBypass && !canDetectPlayer) {
      const fallback = resolveHostileFallback(world, eid);
      if (fallback !== null) {
        virtualPlayerX = fallback.x;
        virtualPlayerY = fallback.y;
        playerDx = virtualPlayerX - enemyX;
        playerDy = virtualPlayerY - enemyY;
        distanceToPlayer = Math.hypot(playerDx, playerDy);
        canDetectPlayer = true;
      }
    }

    const currentVx = velocity.x[eid] ?? 0;
    const currentVy = velocity.y[eid] ?? 0;
    const isMoving = Math.hypot(currentVx, currentVy) > EPSILON;
    if (isMoving) {
      enemyBehavior.stuckFrames[eid] = 0;
    } else {
      enemyBehavior.stuckFrames[eid] = (enemyBehavior.stuckFrames[eid] ?? 0) + 1;
    }
    // A telegraphing enemy is frozen (see below); it must never accumulate a
    // stuck count while stationary-by-design, or it would immediately jiggle
    // via tryUnstuckVelocity on the first post-telegraph frame.
    const isTelegraphing = enemyBehavior.telegraphActive[eid] === 1;
    if (isTelegraphing) {
      enemyBehavior.stuckFrames[eid] = 0;
    }

    if (!canDetectPlayer) {
      getSlimeLeapStateMap(world).delete(eid);
      if (playerHiddenInSafeRoom || inAggroRange) {
        applyIdleWander(world, eid, speed, {
          avoidDoors: true,
          playerX: virtualPlayerX,
          playerY: virtualPlayerY,
        });
      } else {
        applyIdleWander(world, eid, speed);
      }
      pathStates.delete(eid);
      cancelEnemyProjectileTelegraph(world, eid);
      continue;
    }

    const usePathing = floorMap !== null && persona !== PATH_PERSONA.STUPID;
    const recoveryRemainingMs = getMobAbilityRecoveryRemainingMs(world, eid);

    if (recoveryRemainingMs > 0) {
      setVelocity(world, eid, 0, 0);
      enemyBehavior.stuckFrames[eid] = 0;
      cancelEnemyProjectileTelegraph(world, eid);
      activeEnemies.push(eid);
      const tracked = pathStates.get(eid);
      if (tracked) {
        tracked.lastTouchedFrame = world.frameCount;
      }
      continue;
    }

    if (isTelegraphing) {
      // "Stop and aim": freeze movement for the whole telegraph window so the
      // locked origin/direction visually match a stationary shooter. This is
      // a behavioral/visual choice, NOT the correctness mechanism — the real
      // fire spawn and the AI's dodge math both read the LOCKED origin/dir
      // fields (see core/systems/enemyTelegraph.ts), so trajectory correctness
      // holds even if something else displaces this enemy mid-telegraph
      // (separation is exempted below; knockback/other systems are not, and
      // are intentionally out of scope).
      setVelocity(world, eid, 0, 0);
    } else if (
      behaviorType === AI_TYPE.LEAPER &&
      applySlimeLeapBehavior(world, eid, playerDx, playerDy, distanceToPlayer, speed)
    ) {
      // The slime is mid-pounce (telegraph, leap, or frozen recovery) and owns
      // its own movement; nothing else to do this frame.
    } else if (behaviorType === AI_TYPE.LEAPER) {
      // No active pounce: the player is outside the pounce band, or already
      // inside the inner range with no leap in flight. Close like a normal enemy
      // so a melee attacker can land hits; the leap state has already been
      // cleared by applySlimeLeapBehavior.
      if (usePathing) {
        applyPathDrivenBehavior(
          world,
          eid,
          AI_TYPE.CHASE,
          virtualPlayerX,
          virtualPlayerY,
          distanceToPlayer,
          speed,
          attackRange,
          doorRevision,
          groundFlow,
        );
      } else {
        applyLegacyChase(world, eid, playerDx, playerDy, distanceToPlayer, aggroRange, speed);
      }
    } else if (!usePathing) {
      switch (behaviorType) {
        case AI_TYPE.SWARM:
          applyLegacySwarm(
            world,
            eid,
            swarmEntities,
            playerDx,
            playerDy,
            distanceToPlayer,
            aggroRange,
            speed,
          );
          break;
        case AI_TYPE.RANGED:
          applyLegacyRanged(
            world,
            eid,
            playerDx,
            playerDy,
            distanceToPlayer,
            aggroRange,
            attackRange,
            speed,
          );
          break;
        case AI_TYPE.GUARDIAN:
          applyLegacyGuardian(world, eid, playerDx, playerDy, distanceToPlayer, aggroRange, speed);
          break;
        case AI_TYPE.SUPPORT:
          applyLegacySupport(
            world,
            eid,
            playerDx,
            playerDy,
            distanceToPlayer,
            aggroRange,
            attackRange,
            speed,
          );
          break;
        case AI_TYPE.CHASE:
        default:
          applyLegacyChase(world, eid, playerDx, playerDy, distanceToPlayer, aggroRange, speed);
          break;
      }
    } else {
      applyPathDrivenBehavior(
        world,
        eid,
        behaviorType,
        virtualPlayerX,
        virtualPlayerY,
        distanceToPlayer,
        speed,
        attackRange,
        doorRevision,
        groundFlow,
      );
    }

    if (
      behaviorType !== AI_TYPE.SUPPORT &&
      attackRange > EPSILON &&
      distanceToPlayer <= attackRange
    ) {
      tryFireEnemyProjectile(world, eid, playerDx, playerDy);
      // A telegraph can start on THIS frame (tryFireEnemyProjectile just
      // locked origin/direction to the enemy's current position). `isTelegraphing`
      // was computed earlier in the loop — before this call — so the movement
      // branch above already assigned this frame's velocity as if no telegraph
      // were active. Without re-freezing here, the enemy takes one extra step
      // after its origin is locked, visually drifting off the "stop and aim"
      // cue for a frame even though fire/dodge correctness (which read the
      // locked fields, not live position) is unaffected.
      if (!isTelegraphing && enemyBehavior.telegraphActive[eid] === 1) {
        setVelocity(world, eid, 0, 0);
        enemyBehavior.stuckFrames[eid] = 0;
      }
    } else if (isTelegraphing) {
      // Player left attack range while telegraphing — cancel rather than let
      // a stale locked trajectory fire later from a now-meaningless origin.
      cancelEnemyProjectileTelegraph(world, eid);
    }

    activeEnemies.push(eid);
    const tracked = pathStates.get(eid);
    if (tracked) {
      tracked.lastTouchedFrame = world.frameCount;
    }

    // Unstuck: if stuck for too long, try wider pathfinding or jiggle. Gated
    // off while telegraphing (stuckFrames is already forced to 0 above, but
    // the explicit guard removes any doubt this can never fire mid-telegraph).
    const stuckFrames = enemyBehavior.stuckFrames[eid] ?? 0;
    if (stuckFrames > STUCK_FRAMES_THRESHOLD && canDetectPlayer && !isTelegraphing) {
      tryUnstuckVelocity(world, eid, playerDx, playerDy, speed, world.rng);
    }
  }

  applySeparation(world, activeEnemies, position, velocity, playerX, playerY);
}
