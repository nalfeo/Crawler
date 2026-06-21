import { addComponent, query, setComponent } from 'bitecs';
import {
  DoorState,
  Enemy,
  EnemyBehavior,
  EnemyProjectile,
  Player,
  Position,
  Velocity,
} from '../core/components.js';
import { findTilePath, PATH_TRAVERSAL, type TilePoint } from '../core/map/pathfinding.js';
import { spawnAoeProjectile, spawnEnemyProjectile } from '../core/helpers.js';
import { isPointInSafeSpace } from '../core/safe-space.js';
import type { GameWorld } from '../core/world.js';
import { ENEMY_PROJECTILE, TeamId } from '../shared/constants.js';
import { PATH_PERSONA, TRAVERSAL_MODE } from '../shared/enemy-behavior.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { ftToPx } from '../shared/units.js';
import { SeededRandom } from '../shared/random.js';

export const AI_TYPE = { CHASE: 0, SWARM: 1, RANGED: 2, LEAPER: 3 } as const;
export { PATH_PERSONA, TRAVERSAL_MODE };

const DEFAULT_ENEMY_SPEED = 1.5;
const EPSILON = 0.0001;
const SWARM_NEIGHBOR_RADIUS = ftToPx(4);
const SWARM_PLAYER_WEIGHT = 1;
const SWARM_SEPARATION_WEIGHT = 1.4;
const SWARM_COHESION_WEIGHT = 0.2;
const MAX_OVERLAP_FRACTION = 0.25;
const SEPARATION_FORCE = 2.0;
const ENEMY_RADIUS = 8;
const MIN_MOB_PLAYER_DISTANCE = ENEMY_RADIUS * 2 * (1 - MAX_OVERLAP_FRACTION);
const STALE_PATH_FRAMES = 180;
const DEFAULT_PATH_REFRESH_FRAMES = 10;
const DEFAULT_FLANK_DISTANCE = 96;
const TARGET_SEARCH_RADIUS = 8;
const WAYPOINT_EPSILON = 4;
const NAVIGATION_LOOKAHEAD_PX = 24;
const NAVIGATION_ANGLE_OFFSETS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2] as const;
const STUCK_FRAMES_THRESHOLD = 15;
const UNSTUCK_ANGLE_COUNT = 12;
const MAX_PAIRWISE_SEPARATION_ENEMIES = 48;
const SLIME_PREP_MIN_FRAMES = 14;
const SLIME_PREP_MAX_FRAMES = 26;
const SLIME_LEAP_MIN_FRAMES = 5;
const SLIME_LEAP_MAX_FRAMES = 9;
const SLIME_PREP_SPEED_MULT = 0.4;
const SLIME_LEAP_SPEED_MULT = 2.2;
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
  phase: 'prep' | 'leap';
  untilFrame: number;
  leapDirX: number;
  leapDirY: number;
  wiggleSign: number;
}

const pathStatesByWorld = new WeakMap<GameWorld, Map<number, PathState>>();
const doorRevisionByWorld = new WeakMap<GameWorld, DoorRevisionState>();
const wanderStatesByWorld = new WeakMap<GameWorld, Map<number, WanderState>>();
const slimeLeapStatesByWorld = new WeakMap<GameWorld, Map<number, SlimeLeapState>>();

function getWanderStateMap(world: GameWorld): Map<number, WanderState> {
  let map = wanderStatesByWorld.get(world);
  if (!map) {
    map = new Map();
    wanderStatesByWorld.set(world, map);
  }

  function getSlimeLeapStateMap(world: GameWorld): Map<number, SlimeLeapState> {
    let map = slimeLeapStatesByWorld.get(world);
    if (!map) {
      map = new Map();
      slimeLeapStatesByWorld.set(world, map);
    }
    return map;
  }
  return map;
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

function normalize(x: number, y: number): { x: number; y: number; length: number } {
  const length = Math.hypot(x, y);
  if (length <= EPSILON) {
    return { x: 0, y: 0, length: 0 };
  }

  return { x: x / length, y: y / length, length };
}

function getEnemySpeed(world: GameWorld, eid: number): number {
  const speed = world.stores.enemyBehavior.speed[eid]!;
  return speed > 0 ? speed : DEFAULT_ENEMY_SPEED;
}

function applyIdleWander(world: GameWorld, eid: number, speed: number): void {
  const wanderMap = getWanderStateMap(world);
  const px = world.stores.position.x[eid] ?? 0;
  const py = world.stores.position.y[eid] ?? 0;
  let state = wanderMap.get(eid);
  const shouldPickNewDirection =
    !state ||
    world.frameCount >= state.untilFrame ||
    !world.floorMap?.isPassableAt(px + state.dirX * 20, py + state.dirY * 20) ||
    isPointInSafeSpace(world, px + (state?.dirX ?? 0) * 20, py + (state?.dirY ?? 0) * 20);

  if (shouldPickNewDirection) {
    const angle = world.rng.next() * Math.PI * 2;
    state = {
      dirX: Math.cos(angle),
      dirY: Math.sin(angle),
      untilFrame: world.frameCount + world.rng.nextInt(24, 96),
    };
    wanderMap.set(eid, state);
  }

  function createSlimePrepState(world: GameWorld, previousSign = 1): SlimeLeapState {
    return {
      phase: 'prep',
      untilFrame:
        world.frameCount + world.rng.nextInt(SLIME_PREP_MIN_FRAMES, SLIME_PREP_MAX_FRAMES),
      leapDirX: 0,
      leapDirY: 0,
      wiggleSign: previousSign,
    };
  }

  function applySlimeLeapBehavior(
    world: GameWorld,
    eid: number,
    playerDx: number,
    playerDy: number,
    speed: number,
  ): void {
    const slimeMap = getSlimeLeapStateMap(world);
    let state = slimeMap.get(eid);
    if (!state) {
      state = createSlimePrepState(world, world.rng.next() < 0.5 ? -1 : 1);
      slimeMap.set(eid, state);
    }

    if (world.frameCount >= state.untilFrame) {
      if (state.phase === 'prep') {
        const toPlayer = normalize(playerDx, playerDy);
        state.phase = 'leap';
        state.untilFrame =
          world.frameCount + world.rng.nextInt(SLIME_LEAP_MIN_FRAMES, SLIME_LEAP_MAX_FRAMES);
        state.leapDirX = toPlayer.x;
        state.leapDirY = toPlayer.y;
        state.wiggleSign *= -1;
      } else {
        state.phase = 'prep';
        state.untilFrame =
          world.frameCount + world.rng.nextInt(SLIME_PREP_MIN_FRAMES, SLIME_PREP_MAX_FRAMES);
      }
    }

    if (state.phase === 'prep') {
      const toPlayer = normalize(playerDx, playerDy);
      const wigglePulse = 0.5 + Math.sin((world.frameCount + eid) * SLIME_WIGGLE_FREQUENCY) * 0.5;
      const wiggleX = toPlayer.length > EPSILON ? -toPlayer.y * state.wiggleSign : state.wiggleSign;
      const wiggleY = toPlayer.length > EPSILON ? toPlayer.x * state.wiggleSign : 0;
      const desired = normalize(
        wiggleX * SLIME_WIGGLE_BLEND + toPlayer.x * (1 - SLIME_WIGGLE_BLEND),
        wiggleY * SLIME_WIGGLE_BLEND + toPlayer.y * (1 - SLIME_WIGGLE_BLEND),
      );
      const prepSpeed = Math.max(0.2, speed * SLIME_PREP_SPEED_MULT * (0.7 + wigglePulse * 0.3));
      setNavigatingVelocity(world, eid, desired.x, desired.y, prepSpeed);
      return;
    }

    const leapSpeed = Math.max(speed + 0.25, speed * SLIME_LEAP_SPEED_MULT);
    setNavigatingVelocity(world, eid, state.leapDirX, state.leapDirY, leapSpeed);
  }

  if (!state) {
    setVelocity(world, eid, 0, 0);
    return;
  }
  setNavigatingVelocity(world, eid, state.dirX, state.dirY, Math.max(0.2, speed * 0.45));
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
    const sampleX = enemyX + candidate.x * NAVIGATION_LOOKAHEAD_PX;
    const sampleY = enemyY + candidate.y * NAVIGATION_LOOKAHEAD_PX;
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
    const sampleX = enemyX + candidate.x * NAVIGATION_LOOKAHEAD_PX;
    const sampleY = enemyY + candidate.y * NAVIGATION_LOOKAHEAD_PX;
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

function getDoorRevision(world: GameWorld): number {
  const doors = query(world.ecs, [DoorState]);
  const { doorState } = world.stores;
  let hash = 2_166_136_261;

  for (const eid of doors) {
    const tx = doorState.tileX[eid] ?? 0;
    const ty = doorState.tileY[eid] ?? 0;
    const isOpen = doorState.isOpen[eid] ?? 0;
    hash ^= tx * 73856093;
    hash = Math.imul(hash, 16777619);
    hash ^= ty * 19349663;
    hash = Math.imul(hash, 16777619);
    hash ^= isOpen;
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
  return floorMap.pixelToTile(px, py);
}

function makeFlankTargets(
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
    floorMap.config.tileSizePx * 2,
    world.stores.enemyBehavior.flankDistance[eid] || DEFAULT_FLANK_DISTANCE,
  );
  const sideDistance = Math.max(floorMap.config.tileSizePx * 1.5, flankDistance * 0.5);
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
    const waypointCenter = floorMap.tileToPixel(waypoint.x, waypoint.y);
    const delta = normalize(waypointCenter.x - enemyX, waypointCenter.y - enemyY);

    if (delta.length <= maxReach) {
      pathState.waypointIndex += 1;
      continue;
    }

    return { x: delta.x, y: delta.y, valid: true };
  }

  return { x: 0, y: 0, valid: false };
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
    const path = findTilePath(floorMap, enemyTile, targetTile, {
      traversalMode:
        traversalMode === TRAVERSAL_MODE.FLYING ? PATH_TRAVERSAL.FLYING : PATH_TRAVERSAL.GROUND,
      maxPathLength: 8_192,
    });
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
  const tile = floorMap.pixelToTile(enemyX, enemyY);
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

function tryFireEnemyProjectile(
  world: GameWorld,
  eid: number,
  toPlayerX: number,
  toPlayerY: number,
): void {
  const { enemyBehavior, position } = world.stores;
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

  const enemyX = position.x[eid]!;
  const enemyY = position.y[eid]!;
  const spawnX = enemyX + direction.x * ENEMY_PROJECTILE.MUZZLE_OFFSET;
  const spawnY = enemyY + direction.y * ENEMY_PROJECTILE.MUZZLE_OFFSET;

  if (FIREBALL_DEF) {
    const projectile = spawnAoeProjectile(
      world,
      spawnX,
      spawnY,
      direction.x * FIREBALL_DEF.projectileSpeed,
      direction.y * FIREBALL_DEF.projectileSpeed,
      FIREBALL_DEF.baseDamage,
      ftToPx(FIREBALL_DEF.aoeRadius),
      FIREBALL_DEF.baseDamage,
      eid,
      TeamId.ENEMY,
      ftToPx(FIREBALL_DEF.range),
    );
    addComponent(world.ecs, projectile, EnemyProjectile);
  } else {
    spawnEnemyProjectile(
      world,
      spawnX,
      spawnY,
      direction.x * ENEMY_PROJECTILE.SPEED,
      direction.y * ENEMY_PROJECTILE.SPEED,
      ENEMY_PROJECTILE.DAMAGE,
    );
  }

  enemyBehavior.lastFireMs[eid] = world.elapsedMs;
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
): void {
  const enemyX = world.stores.position.x[eid] ?? 0;
  const enemyY = world.stores.position.y[eid] ?? 0;
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
    setVelocity(world, eid, 0, 0);
    return;
  }

  let targetTile = personaTarget;
  if (behaviorType === AI_TYPE.RANGED) {
    const rangedTargetPx = buildRangedPathTarget(
      eid,
      enemyX,
      enemyY,
      playerX,
      playerY,
      distanceToPlayer,
      attackRange,
    );
    const preferred = asTilePoint(world, rangedTargetPx.x, rangedTargetPx.y);
    const fallback = findNearestTraversableTile(world, preferred, traversalMode);
    if (fallback) {
      targetTile = fallback;
    }
  }

  const usedPath = followPathWithCaching(
    world,
    eid,
    speed,
    targetTile,
    traversalMode,
    doorRevision,
  );

  if (!usedPath) {
    const waypoint = world.floorMap?.tileToPixel(targetTile.x, targetTile.y);
    if (!waypoint) {
      setVelocity(world, eid, 0, 0);
      return;
    }
    const fallback = normalize(waypoint.x - enemyX, waypoint.y - enemyY);
    setVelocity(world, eid, fallback.x * speed, fallback.y * speed);
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
      velocity.x[a] = (velocity.x[a] ?? 0) + nx * force;
      velocity.y[a] = (velocity.y[a] ?? 0) + ny * force;
      velocity.x[b] = (velocity.x[b] ?? 0) - nx * force;
      velocity.y[b] = (velocity.y[b] ?? 0) - ny * force;
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
    const maxSpeed = getEnemySpeed(world, eid);

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

  if (world.frameCount % 60 === 0) {
    trimStalePaths(world, pathStates);
  }

  if (playerEid === undefined) {
    const slimeMap = getSlimeLeapStateMap(world);
    for (const eid of enemies) {
      setVelocity(world, eid, 0, 0);
      pathStates.delete(eid);
      slimeMap.delete(eid);
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
  const doorRevision = floorMap ? getDoorRevision(world) : 0;

  for (const eid of enemies) {
    const enemyX = position.x[eid]!;
    const enemyY = position.y[eid]!;
    const playerDx = playerX - enemyX;
    const playerDy = playerY - enemyY;
    const distanceToPlayer = Math.hypot(playerDx, playerDy);
    const behaviorType = enemyBehavior.type[eid]!;
    const aggroRange = enemyBehavior.aggroRange[eid]!;
    const attackRange = enemyBehavior.attackRange[eid]!;
    const speed = getEnemySpeed(world, eid);
    const persona = enemyBehavior.persona[eid] ?? PATH_PERSONA.NAVIGATOR;
    const hasOpenRoomDoor = isEnemyRoomDoorOpen(world, eid);
    const permanentAggro = (enemyBehavior.aggroedPermanently?.[eid] ?? 0) === 1;
    const inAggroRange = permanentAggro || isAggroActive(aggroRange, distanceToPlayer);
    const canDetectPlayer = (hasOpenRoomDoor || permanentAggro) && inAggroRange;

    const currentVx = velocity.x[eid] ?? 0;
    const currentVy = velocity.y[eid] ?? 0;
    const isMoving = Math.hypot(currentVx, currentVy) > EPSILON;
    if (isMoving) {
      enemyBehavior.stuckFrames[eid] = 0;
    } else {
      enemyBehavior.stuckFrames[eid] = (enemyBehavior.stuckFrames[eid] ?? 0) + 1;
    }

    if (!canDetectPlayer) {
      getSlimeLeapStateMap(world).delete(eid);
      if (!inAggroRange) {
        applyIdleWander(world, eid, speed);
      } else {
        setVelocity(world, eid, 0, 0);
      }
      pathStates.delete(eid);
      continue;
    }

    const usePathing = floorMap !== null && persona !== PATH_PERSONA.STUPID;

    if (behaviorType === AI_TYPE.LEAPER) {
      applySlimeLeapBehavior(world, eid, playerDx, playerDy, speed);
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
        playerX,
        playerY,
        distanceToPlayer,
        speed,
        attackRange,
        doorRevision,
      );
    }

    if (attackRange > EPSILON && distanceToPlayer <= attackRange) {
      tryFireEnemyProjectile(world, eid, playerDx, playerDy);
    }

    activeEnemies.push(eid);
    const tracked = pathStates.get(eid);
    if (tracked) {
      tracked.lastTouchedFrame = world.frameCount;
    }

    // Unstuck: if stuck for too long, try wider pathfinding or jiggle
    const stuckFrames = enemyBehavior.stuckFrames[eid] ?? 0;
    if (stuckFrames > STUCK_FRAMES_THRESHOLD && canDetectPlayer) {
      tryUnstuckVelocity(world, eid, playerDx, playerDy, speed, world.rng);
    }
  }

  applySeparation(world, activeEnemies, position, velocity, playerX, playerY);
}
